// End-to-end test of the phone app at iPhone size, against a pretend Google Drive.
// Run: node tests/phone.e2e.mjs   (needs the "playwright" package and Chromium; saves screenshots in tests/out/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { FakeDrive, installFakeGoogle } from "./fake-google.mjs";
import * as core from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, "..");
const out = join(here, "out");
mkdirSync(out, { recursive: true });
const PY_APP = process.env.DESIGN_BOARD_PY || join(appRoot, "..", "designboard");

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const p of ["playwright", "/opt/node-tools/node_modules/playwright", "/opt/npm-tools/node_modules/playwright"]) {
    try { return require(p); } catch { /* next */ }
  }
  throw new Error("playwright is not installed");
}

/** Pictures for the test designs (made with Pillow so they're real PNG/JPG files). */
function makePictures(names) {
  const dir = mkdtempSync(join(tmpdir(), "dbpics-"));
  execFileSync("python3", ["-c", `
import sys, random
from PIL import Image, ImageDraw
d = sys.argv[1]
for i, name in enumerate(sys.argv[2:]):
    rnd = random.Random(i * 7 + 3)
    rgb = name.lower().endswith(".jpg")
    img = Image.new("RGB" if rgb else "RGBA", (300, 360), (240, 236, 228) if rgb else (0, 0, 0, 0))
    dr = ImageDraw.Draw(img)
    for _ in range(6):
        x0, y0 = rnd.randint(0, 240), rnd.randint(0, 300)
        col = tuple(rnd.randint(30, 230) for _ in range(3)) + (255,)
        (dr.ellipse if rnd.random() < .5 else dr.rectangle)([x0, y0, x0 + rnd.randint(40, 140), y0 + rnd.randint(40, 140)], fill=col[:3] if rgb else col)
    dr.text((10, 10), name, fill=(20, 20, 20) if rgb else (20, 20, 20, 255))
    img.save(f"{d}/{name}")
`, dir, ...names]);
  return Object.fromEntries(names.map((n) => [n, readFileSync(join(dir, n))]));
}

function buildDrive() {
  const files = ["0296.jpg", "0296-v1.png", "0296-v2.png", "0296-v3.png", "0297.jpg", "0297-v1.png", "0297-v2.png",
    "0297-v3.png", "0297-v4.png", "0299.jpg", "mama-bear.png", "ChatGPT Image Oct 14, 2026, 03_51_10 PM.png"];
  const pics = makePictures(files);
  const d = new FakeDrive();
  const root = d.folder("My Drive");
  const shared = d.folder("Trev + Sean Etsy 2026", root);
  const designs = d.folder("Comparisions Folder", d.folder("Automation Stuff", shared));
  const masters = d.folder("Tees Masterfile", d.folder("Product Masterfiles", d.folder("Planning", shared)));
  const cotton = d.folder("1. Cotton Theory", masters);
  const teepals = d.folder("2. Teepals (CC cute)", masters);
  d.folder("2. Teepals (CC cute)", d.folder("Old stuff", root));  // a decoy with the same name
  const data = d.folder("_Design Board", designs);
  d.add({ name: "shops.csv", parent: data, content: "﻿shop,folder_hint\r\nCotton Theory,Tees Masterfile/1. Cotton Theory\r\nTeepals,Tees Masterfile/2. Teepals (CC cute)\r\n" });
  for (const n of files.slice(0, -1)) d.add({ name: n, parent: designs, content: pics[n] });
  // the Windows app (on the PC) already starred 0297-v1
  const key = (name) => core.makeDesign && require_sha1(pics[name]);
  const pcLog = core.appendToLog("", { id: "pc1", time: "2026-10-14T08:00:00.000000Z", user: "Trevor", computer: "DESKTOP-7QGQARU",
    action: core.STAR, design: key("0297-v1.png"), file: "0297-v1.png", from_place: core.UNASSIGNED, from_sub: "", to_place: "", to_sub: "",
    new_file: "", ref: "", note: "" });
  d.add({ name: "log-trevor-desktop-7qgqaru.csv", parent: data, content: pcLog });
  return { d, ids: { designs, data, cotton, teepals }, pics, files };
}

import { createHash } from "node:crypto";
function require_sha1(buf) { return createHash("sha1").update(buf).digest("hex").slice(0, 16); }

test("the phone app at iPhone size, against a pretend Google Drive", async () => {
  const { chromium, devices } = loadPlaywright();
  const browser = await chromium.launch(existsSync("/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    ? { executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" } : {});
  const context = await browser.newContext({ ...devices["iPhone 13"], permissions: ["clipboard-read", "clipboard-write"] });
  const { d, ids, pics } = buildDrive();
  await installFakeGoogle(context, d, { appRoot, readFile });
  const page = await context.newPage();
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
  page.on("pageerror", (e) => logs.push(String(e)));
  const shot = (name) => page.screenshot({ path: join(out, name) });
  const app = () => page.evaluate(() => {
    const s = window.__designBoard.state;
    return s && [...s.designs.values()].map((x) => ({ key: x.key, file: x.file, place: x.place, sub: x.sub, starred: x.starred, comment: x.comment }));
  });

  try {
    // ---- first open: sign in, then the welcome sheet finds the Designs folder by itself
    await page.goto("https://app.test/index.html");
    await page.getByRole("button", { name: "Sign in with Google" }).waitFor();
    await shot("phone-0-sign-in.png");
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByText("Welcome!").waitFor();
    await page.locator(".choice", { hasText: "Comparisions Folder" }).waitFor();
    assert.equal(await page.locator('.sheet input[type="text"]').first().inputValue(), "Trevor");
    await shot("phone-1-welcome.png");
    await page.getByRole("button", { name: "Start" }).click();

    // ---- the board: rows, original first, the PC's star
    await page.locator(".row").first().waitFor({ timeout: 15000 });
    const rowTitles = await page.locator(".row-head h2").allTextContents();
    assert.deepEqual(rowTitles, ["Row 0299", "Row 0297", "Row 0296", "Other designs"]);
    const row97 = await page.locator('.row[data-row="0297"] .card .name').allTextContents();
    assert.deepEqual(row97, ["0297.jpg", "0297-v1.png", "0297-v2.png", "0297-v3.png", "0297-v4.png"]);
    assert.equal(await page.locator('.row[data-row="0297"] .card').first().locator("select").count(), 0, "the original has no shop dropdown");
    assert.ok(await page.locator('.row[data-row="0297"] .card').nth(1).locator(".star.on").count(), "star from the PC");
    const settings = await page.evaluate(() => window.__designBoard.settings);
    assert.equal(settings.shopFolderIds["Teepals"], ids.teepals, "found the right Teepals folder, not the decoy");
    assert.equal(settings.shopFolderIds["Cotton Theory"], ids.cotton);
    await page.waitForTimeout(400);
    await shot("phone-2-board.png");

    // ---- assign 0297-v2 to Teepals, then undo it from the toast
    const v2 = d.byName("0297-v2.png");
    await page.locator('.row[data-row="0297"] .card').nth(2).locator("select").selectOption("Teepals");
    await page.locator("#toast", { hasText: "Moved “0297-v2.png” to Teepals" }).waitFor();
    assert.equal(v2.parents[0], ids.teepals, "moved in Drive");
    await shot("phone-3-moved.png");
    const phoneLog = d.childrenOf(ids.data).find((f) => /^log-trevor-phone-/.test(f.name));
    assert.ok(phoneLog, "the phone writes its own log file");
    await page.locator("#toastAction").click();
    await page.locator("#toast", { hasText: "back" }).waitFor();
    assert.equal(v2.parents[0], ids.designs, "undo put it back");

    // ---- star and comment
    await page.locator('.row[data-row="0296"] .card').nth(1).locator(".star").click();
    await page.waitForFunction(() => [...window.__designBoard.state.designs.values()].some((x) => x.file === "0296-v1.png" && x.starred));
    const box = page.locator('.row[data-row="0296"] .card').nth(1).locator("input.comment");
    await box.fill("Make the text bigger");
    await box.press("Enter");
    await page.waitForFunction(() => [...window.__designBoard.state.designs.values()].some((x) => x.file === "0296-v1.png" && x.comment === "Make the text bigger"));

    // ---- send it to To be edited: own folder, a copy of the original and a ChatGPT prompt
    await page.locator('.row[data-row="0296"] .card').nth(1).locator("select").selectOption(core.EDIT_PLACE);
    await page.locator("#toast", { hasText: "Sent “0296-v1.png” to To be edited" }).waitFor();
    const edit = d.byName("To be edited", ids.designs);
    const own = d.byName("0296-v1", edit.id);
    assert.ok(own, "its own folder");
    assert.deepEqual(d.childrenOf(own.id).map((f) => f.name).sort(), ["0296 original.jpg", "0296-v1.png", "ChatGPT prompt.txt"]);
    assert.ok(d.byName("0296.jpg", ids.designs), "the original stays");
    const prompt = d.byName("ChatGPT prompt.txt", own.id).data.toString("utf8");
    const designForPrompt = core.makeDesign({ file: "0296-v1.png", width: 300, height: 360, comment: "Make the text bigger" });
    assert.equal(prompt, core.promptFileText(core.promptText(designForPrompt, "0296 original.jpg")), "same prompt as the Windows app");

    // ---- the To be edited view, copy the prompt
    await page.locator("#view").selectOption("edit");
    await page.locator('.row[data-row="0296"]').waitFor();
    assert.deepEqual(await page.locator('.row[data-row="0296"] .card .name').allTextContents(), ["0296.jpg", "0296-v1.png"]);
    await page.getByRole("button", { name: "📋 Prompt" }).click();
    await page.locator("#toast", { hasText: "prompt copied" }).waitFor();
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    assert.ok(clip.includes("• Make the text bigger") && clip.includes("0296 original.jpg"));
    await shot("phone-4-to-be-edited.png");

    // ---- ChatGPT's result saved into the folder: an edited version, sent to a shop with a tidy name
    const resultName = "ChatGPT Image Oct 14, 2026, 03_51_10 PM.png";
    const resultId = d.add({ name: resultName, parent: own.id, content: pics[resultName] });
    await page.locator("#refreshBtn").click();
    await page.locator('.row[data-row="0296"] .card.ready').waitFor({ timeout: 15000 });
    assert.deepEqual(await page.locator('.row[data-row="0296"] .card .name').allTextContents(), ["0296.jpg", "0296-v1.png", resultName]);
    await shot("phone-5-edited-version.png");
    await page.locator('.row[data-row="0296"] .card.ready select').selectOption("Cotton Theory");
    await page.locator("#toast", { hasText: "Cotton Theory" }).waitFor();
    assert.equal(d.files.get(resultId).name, "0296-v1-edited.png");
    assert.equal(d.files.get(resultId).parents[0], ids.cotton);

    // ---- the big viewer: a whole row, swipe sideways
    await page.locator("#view").selectOption("unassigned");
    await page.locator('.row[data-row="0297"] .card').nth(1).locator(".pic").click();
    await page.locator("#viewer").waitFor({ state: "visible" });
    assert.match(await page.locator("#viewerTitle").textContent(), /Row 0297 · 2 of 5/);
    await page.evaluate(() => { const s = document.getElementById("viewerStrip"); s.scrollLeft = s.clientWidth * 2; });
    await page.waitForFunction(() => /3 of 5/.test(document.getElementById("viewerTitle").textContent));
    await page.waitForTimeout(500);
    await shot("phone-6-viewer.png");
    await page.locator("#viewerClose").click();

    // ---- nothing matches: the whole picture
    await page.locator("#search").fill("nothing-has-this-name");
    await page.locator(".empty").waitFor();
    await shot("phone-7-nothing.png");
    await page.locator("#search").fill("");

    // ---- refresh, then the state matches Drive
    await page.locator("#refreshBtn").click();
    await page.waitForTimeout(800);
    const now = await app();
    const byFile = Object.fromEntries(now.map((x) => [x.file, x]));
    assert.equal(byFile["0296-v1.png"].place, core.EDIT_PLACE);
    assert.equal(byFile["0296-v1.png"].comment, "Make the text bigger");
    assert.ok(byFile["0296-v1.png"].starred);
    assert.equal(byFile["0297-v2.png"].place, core.UNASSIGNED);
    assert.equal(byFile["0296-v1-edited.png"].place, "Cotton Theory");

    // ---- the Windows app can read everything the phone wrote
    const logText = d.text(phoneLog.id);
    writeFileSync(join(out, "phone-log.csv"), logText);
    if (existsSync(join(PY_APP, "design_board", "shared.py"))) {
      const tmp = mkdtempSync(join(tmpdir(), "dblog-"));
      writeFileSync(join(tmp, phoneLog.name), logText);
      const actions = JSON.parse(execFileSync("python3", ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PY_APP)})
from pathlib import Path
from design_board import shared
print(json.dumps([e.action for e in shared.read_events(Path(${JSON.stringify(tmp)}))]))
`]).toString());
      assert.deepEqual(actions, ["move", "undo", "star", "comment", "move", "copy", "move"]);
    }
    assert.deepEqual(logs.filter((l) => !/favicon/.test(l)), [], "no errors in the page");
  } finally {
    await shot("phone-last.png").catch(() => {});
    await browser.close();
  }
});
