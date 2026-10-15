// Tests for the logic shared with the Windows app. Run: node --test tests/
// Where the Windows app's code is available (../designboard), the log files are checked both ways with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as core from "../core.js";

const here = dirname(fileURLToPath(import.meta.url));
const PY_APP = process.env.DESIGN_BOARD_PY || join(here, "..", "..", "designboard");
const havePython = existsSync(join(PY_APP, "design_board", "shared.py"));

function ev(fields) {
  return { id: core.newId(), time: core.nowIso(), user: "Trevor", computer: "phone-ab12", action: core.STAR,
    design: "k1", file: "a.png", from_place: "", from_sub: "", to_place: "", to_sub: "", new_file: "", ref: "",
    note: "", ...fields };
}

test("names: rows and variants like the Windows app", () => {
  assert.deepEqual(core.parseName("0297-v1.png"), { row: "0297", variant: 1 });
  assert.deepEqual(core.parseName("0297_V2.PNG"), { row: "0297", variant: 2 });
  assert.deepEqual(core.parseName("0297 v12.png"), { row: "0297", variant: 12 });
  assert.deepEqual(core.parseName("0297-v2 (2).png"), { row: "0297", variant: 2 });
  assert.deepEqual(core.parseName("0297-v1-final.png"), { row: "0297", variant: 1 });
  assert.deepEqual(core.parseName("0297.jpg"), { row: "0297", variant: null });
  assert.deepEqual(core.parseName("0297 (2).jpg"), { row: "0297", variant: null });
  assert.equal(core.parseName("vintage-cat.png").variant, null);
  assert.equal(core.parseName("dove3.png").variant, null);
  assert.ok(core.compareNatural("row 9", "row 10") < 0);
});

test("rows: original first, then v1, v2…; newest row first", () => {
  const files = ["0297-v3.png", "0297.jpg", "0297-v1.png", "0297-v4.png", "0297-v2.png", "0298-v1.png",
    "0299.jpg", "mama-bear.png", "0300-v2.png", "0300.jpg", "0300-v10.png"];
  const ds = files.map((f) => core.makeDesign({ key: f, file: f }));
  core.annotate(ds);
  const rows = core.buildRows(ds);
  assert.deepEqual(rows.map((r) => r.label), ["0300", "0299", "0298", "0297", "Other designs"]);
  assert.deepEqual(rows[3].items.map((d) => d.file), ["0297.jpg", "0297-v1.png", "0297-v2.png", "0297-v3.png", "0297-v4.png"]);
  assert.deepEqual(rows[0].items.map((d) => d.file), ["0300.jpg", "0300-v2.png", "0300-v10.png"]);
  assert.deepEqual(core.buildRows(ds, false).map((r) => r.label), ["0297", "0298", "0299", "0300", "Other designs"]);
  const byName = Object.fromEntries(ds.map((d) => [d.file, d]));
  assert.ok(byName["0297.jpg"].isOriginal && byName["0299.jpg"].isOriginal);
  assert.ok(!byName["mama-bear.png"].isOriginal);
  byName["0297-v2.png"].place = "Teepals";
  const shown = core.visibleRows(core.buildRows(ds), "shop:Teepals");
  assert.deepEqual(shown.map(({ items }) => items.map((d) => d.file)), [["0297.jpg", "0297-v2.png"]]);
  const un = core.visibleRows(core.buildRows(ds), "unassigned");
  assert.deepEqual(un.find(({ row }) => row.label === "0299").items.map((d) => d.file), ["0299.jpg"]);
});

test("an edited version saved in To be edited/0312-v1 sits after v1 in row 0312", () => {
  const ds = [core.makeDesign({ key: "o", file: "0312.jpg" }), core.makeDesign({ key: "v1", file: "0312-v1.png", place: core.EDIT_PLACE, sub: "0312-v1" }),
    core.makeDesign({ key: "v2", file: "0312-v2.png" }),
    core.makeDesign({ key: "r", file: "ChatGPT Image Oct 14.png", place: core.EDIT_PLACE, sub: "0312-v1", isEditResult: true })];
  core.annotate(ds);
  const row = core.buildRows(ds)[0];
  assert.deepEqual(row.items.map((d) => d.key), ["o", "v1", "r", "v2"]);
  assert.equal(core.editedName(ds[3]), "0312-v1-edited.png");
  assert.ok(core.readyForReview(ds[3]));
});

test("CSV: quotes, commas, new lines and the byte-order mark", () => {
  const e = ev({ action: core.COMMENT, note: 'Bigger "text", please\nand brighter' });
  const text = core.appendToLog("", e);
  assert.ok(text.startsWith("﻿" + core.LOG_FIELDS.join(",") + "\r\n"));
  const back = core.readEvents([text]);
  assert.equal(back.length, 1);
  assert.equal(back[0].note, 'Bigger "text", please\nand brighter');
  const two = core.appendToLog(text, ev({ action: core.UNSTAR }));
  assert.equal(core.readEvents([two]).length, 2);
});

test("an old log without the note column is upgraded when the phone adds to it", () => {
  const old = "﻿" + core.LOG_FIELDS.filter((f) => f !== "note").join(",") + "\r\nold1,2026-10-13T10:00:00.000000Z,Trevor,PC,star,abc,x.png,,,,,,\r\n";
  const text = core.appendToLog(old, ev({ action: core.COMMENT, note: "Hello" }));
  const rows = core.parseCsv(text);
  assert.deepEqual(rows[0], core.LOG_FIELDS);
  const evs = core.readEvents([text]);
  assert.deepEqual(evs.map((e) => e.action), ["star", "comment"]);
});

test("times look like the Windows app's", () => {
  assert.match(core.nowIso(new Date(Date.UTC(2026, 9, 14, 8, 5, 41, 663))), /^2026-10-14T08:05:41\.663000Z$/);
});

test("replay: stars, comments, moves, undo, and edited files", () => {
  const observed = [
    { key: "k1", file: "0297-v1.png", sub: "", fileId: "f1", parentId: "D", added: 1 },
    { key: "k0", file: "0297.jpg", sub: "", fileId: "f0", parentId: "D", added: 1 },
  ];
  const t = (s) => `2026-10-14T08:00:0${s}.000000Z`;
  const events = [
    ev({ id: "a", time: t(1), design: "k1", action: core.STAR }),
    ev({ id: "b", time: t(2), design: "k2", file: "0297-v2.png", action: core.MOVE, from_place: core.UNASSIGNED, to_place: "Teepals", new_file: "0297-v2.png" }),
    ev({ id: "c", time: t(3), design: "k3", file: "0297-v3.png", action: core.MOVE, from_place: core.UNASSIGNED, to_place: core.EDIT_PLACE, to_sub: "0297-v3", new_file: "0297-v3.png" }),
    ev({ id: "d", time: t(4), design: "k3", action: core.COMMENT, note: "Bigger" }),
  ];
  const files = { "Teepals||0297-v2.png": { id: "f2", parentId: "T", key: "k2" }, "To be edited|0297-v3|0297-v3.png": { id: "f3", parentId: "E3", key: "OTHER" } };
  const { designs } = core.replay(observed, events, (p, s, f) => files[`${p}|${s}|${f}`] || null);
  assert.ok(designs.get("k1").starred);
  assert.equal(designs.get("k2").place, "Teepals");
  assert.equal(designs.get("k2").fileId, "f2");
  assert.equal(designs.get("k3").comment, "Bigger");
  assert.ok(designs.get("k3").edited, "saved over in its folder");
  assert.ok(designs.get("k0").isOriginal);
  const state = { designs, events: [...events], undone: new Set() };
  assert.deepEqual(core.undoStatus(state, events[1]), [true, ""]);
});

test("prompt text is the same as the Windows app's", { skip: !havePython && "Windows app code not found" }, () => {
  const d = core.makeDesign({ key: "k", file: "0312-v1.png", width: 896, height: 1024, comment: "Only 4 pumpkins" });
  const js = core.promptFileText(core.promptText(d, "0312 original.jpg"));
  const py = execFileSync("python3", ["-c", `
import sys; sys.path.insert(0, ${JSON.stringify(PY_APP)})
from design_board.board import Design
from design_board import editing
d = Design(key="k", file="0312-v1.png", place="x", sub="", path=None, found=True, added=0, width=896, height=1024)
d.comment = "Only 4 pumpkins"
text = editing.prompt_text(d, "0312 original.jpg")
data = text.replace("\\r\\n", "\\n").replace("\\n", "\\r\\n").encode("utf-8-sig")
sys.stdout.buffer.write(data)
`]);
  assert.equal(Buffer.from(js, "utf8").toString("hex"), py.toString("hex"));
});

test("the Windows app reads the phone's log, and the phone reads the Windows app's", { skip: !havePython && "Windows app code not found" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "dboard-"));
  let text = core.appendToLog("", ev({ id: "p1", action: core.COMMENT, note: 'Make it "pop", ok' }));
  text = core.appendToLog(text, ev({ id: "p2", action: core.MOVE, design: "k9", file: "0300-v1.png", from_place: core.UNASSIGNED, to_place: core.EDIT_PLACE, to_sub: "0300-v1", new_file: "0300-v1.png" }));
  writeFileSync(join(dir, "log-trevor-phone-ab12.csv"), text, "utf8");
  const out = execFileSync("python3", ["-c", `
import sys, json; sys.path.insert(0, ${JSON.stringify(PY_APP)})
from pathlib import Path
from design_board import shared
d = Path(${JSON.stringify(dir)})
evs = shared.read_events(d)
print(json.dumps([[e.id, e.action, e.note, e.to_sub, e.when.isoformat()] for e in evs]))
shared.append_event(d / "log-trevor-pc.csv", shared.Event(id="w1", time=shared.now_iso(), user="Trevor", computer="PC",
    action="comment", design="k1", file="a.png", note='From "Windows", hi'))
`]).toString();
  const parsed = JSON.parse(out);
  assert.deepEqual(parsed.map((r) => r.slice(0, 4)), [["p1", "comment", 'Make it "pop", ok', ""], ["p2", "move", "", "0300-v1"]]);
  const winText = readFileSync(join(dir, "log-trevor-pc.csv"), "utf8");
  const back = core.readEvents([winText, text]);
  assert.deepEqual(back.map((e) => e.id).sort(), ["p1", "p2", "w1"]);
  assert.equal(back.find((e) => e.id === "w1").note, 'From "Windows", hi');
});

test("unique names never overwrite", () => {
  assert.equal(core.uniqueName("a.png", ["b.png"]), "a.png");
  assert.equal(core.uniqueName("a.png", ["A.png", "a (2).png"]), "a (3).png");
});

test("shops.csv from the Windows app", () => {
  const shops = core.readShops("﻿shop,folder_hint\r\nCotton Theory,Tees Masterfile/1. Cotton Theory\r\nTo be edited,x/y\r\n");
  assert.deepEqual(shops, [{ name: "Cotton Theory", hint: "Tees Masterfile/1. Cotton Theory" }]);
});
