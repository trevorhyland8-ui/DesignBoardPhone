// Design Board on the phone: the screens.

import * as core from "./core.js";
import { CONFIG } from "./config.js";
import { AuthError, Drive, folderLink, idFromLink, initSignIn, savedToken, signIn, signOut } from "./drive.js";
import { BoardError, PhoneBoard } from "./board.js";

const $ = (id) => document.getElementById(id);
const SETTINGS_KEY = "designboard.settings";
const BACKGROUNDS = { checker: "Transparent", white: "White shirt", black: "Black shirt", grey: "Grey shirt" };
const NOT_ASSIGNED_LABEL = "— Not assigned —";
const EDIT_LABEL = "✎ To be edited";

// ------------------------------------------------------------------ settings (this phone only)
function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { /* private mode */ }
  return {
    userName: "", email: "", designsFolderId: "", shopFolderIds: {}, view: "unassigned", newestFirst: true,
    background: "checker", device: "", ...s,
  };
}
const settings = loadSettings();
if (!settings.device) settings.device = `phone-${core.newId().slice(0, 4)}`;  // each phone writes its own log file
function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}
saveSettings();

let drive = null, board = null, state = null;
let busy = 0, lastLoad = 0, loading = false;
const blobUrls = new Map();

// ------------------------------------------------------------------ small helpers
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(e.dataset, v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
}

function shortTime(ev) {
  if (!ev) return "";
  const d = new Date(core.eventTime(ev));
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short" }) + " " +
    d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function setBusy(on) {
  busy = Math.max(0, busy + (on ? 1 : -1));
  $("busy").hidden = busy === 0 && !loading;
}

let toastTimer = 0;
function toast(text, { action = null, label = "Undo", error = false, ms = 7000 } = {}) {
  const t = $("toast");
  $("toastText").textContent = text;
  t.classList.toggle("error", error);
  const b = $("toastAction");
  b.hidden = !action;
  b.textContent = label;
  b.onclick = action ? () => { t.hidden = true; action(); } : null;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function splash(html, actions = []) {
  $("splash").hidden = false;
  $("splashText").innerHTML = html;
  const box = $("splashActions");
  box.replaceChildren(...actions);
}

function hideSplash() {
  $("splash").hidden = true;
}

function thumbUrl(d, size) {
  if (!d.thumb) return "";
  return d.thumb.replace(/=s\d+(-[a-z]+)?$/, `=s${size}`).replace(/=w\d+-h\d+.*$/, `=s${size}`);
}

async function fullImage(d) {
  if (!d.fileId) return "";
  if (blobUrls.has(d.fileId)) return blobUrls.get(d.fileId);
  const blob = await drive.blob(d.fileId);
  const url = URL.createObjectURL(blob);
  blobUrls.set(d.fileId, url);
  if (blobUrls.size > 24) {  // keep memory low on phones
    const [oldId, oldUrl] = blobUrls.entries().next().value;
    URL.revokeObjectURL(oldUrl); blobUrls.delete(oldId);
  }
  return url;
}

// When Google's small preview can't be shown, load the file itself (a few at a time).
const fallbackQueue = [];
let fallbackRunning = 0;
function fallbackImage(img) {
  if (img.dataset.fallback === "1") return;
  img.dataset.fallback = "1";
  fallbackQueue.push(img);
  pumpFallback();
}
function pumpFallback() {
  while (fallbackRunning < 3 && fallbackQueue.length) {
    const img = fallbackQueue.shift();
    const d = state?.designs.get(img.dataset.key);
    if (!d) continue;
    fallbackRunning++;
    fullImage(d).then((url) => { img.src = url; }).catch(() => {
      img.replaceWith(el("span", { class: "noimg", text: d.found ? "No preview" : "Not found" }));
    }).finally(() => { fallbackRunning--; pumpFallback(); });
  }
}

// ------------------------------------------------------------------ describing a design
function describe(d) {
  if (!d.found) {
    const where = core.assigned(d) ? d.place : "the Designs folder";
    return [`Not found in ${where}: still syncing, or moved outside the app.`, true];
  }
  const parts = [];
  if (d.isOriginal) parts.push("Original (reference)");
  if (d.isEditResult && d.place === core.EDIT_PLACE) parts.unshift("✓ Edited version, ready to review");
  else if (core.readyForReview(d)) parts.unshift("✓ Edited, ready to review");
  if (d.width) parts.push(`${d.width} × ${d.height}`);
  const lm = d.lastMove;
  if (d.place === core.EDIT_PLACE && lm) parts.push(`sent to edit by ${lm.user}, ${shortTime(lm)}`);
  else if (core.assigned(d) && lm) parts.push(`moved by ${lm.user}, ${shortTime(lm)}`);
  else if (d.isEditResult && d.sub) parts.push(`in ${d.sub}`);
  else if (lm && lm.to_place !== core.UNASSIGNED) parts.push(`${lm.user} moved this to ${lm.to_place}; waiting for Drive to sync`);
  else if (d.sub) parts.push(`in ${d.sub}`);
  if (d.starred && d.starredBy) parts.push(`★ ${d.starredBy}`);
  return [parts.join(" · "), false];
}

function shopSelect(d) {
  const s = el("select", { class: "shop", "aria-label": "Shop", dataset: { key: d.key } });
  const names = state.shops.map((x) => x.name);
  s.append(el("option", { value: core.UNASSIGNED, text: NOT_ASSIGNED_LABEL }));
  s.append(el("option", { value: core.EDIT_PLACE, text: EDIT_LABEL }));
  s.append(el("option", { disabled: true, text: "──────────" }));
  for (const n of names) s.append(el("option", { value: n, text: n }));
  if (core.assigned(d) && d.place !== core.EDIT_PLACE && !names.includes(d.place)) s.append(el("option", { value: d.place, text: d.place }));
  s.value = d.place;
  s.disabled = !d.found;
  if (d.place === core.EDIT_PLACE) s.classList.add("editing");
  else if (core.assigned(d)) s.classList.add("assigned");
  return s;
}

function card(d) {
  const original = d.isOriginal && !core.assigned(d);
  const [meta, warn] = describe(d);
  const classes = ["card"];
  if (original) classes.push("original");
  if (core.readyForReview(d)) classes.push("ready");
  if (!d.found) classes.push("missing");
  const src = thumbUrl(d, 600);
  const pic = el("div", { class: "pic", dataset: { open: d.key } },
    src ? el("img", { src, alt: d.file, loading: "lazy", decoding: "async", referrerpolicy: "no-referrer", dataset: { key: d.key } })
        : el("span", { class: "noimg", text: d.found ? "No preview" : "Not found" }));
  const line = el("div", { class: "line1" },
    original ? null : el("button", { class: `star${d.starred ? " on" : ""}`, "aria-label": d.starred ? "Remove star" : "Star",
      text: d.starred ? "★" : "☆", dataset: { star: d.key } }),
    el("span", { class: "name", title: d.file, text: d.file }));
  const parts = [pic, line];
  if (original) {
    parts.push(el("div", { class: "orig-tag", text: "Original" }), el("div", { class: "spacer" }));
  } else {
    parts.push(shopSelect(d));
    parts.push(el("input", { class: `comment${d.comment ? " filled" : ""}`, type: "text", value: d.comment,
      placeholder: "Add a comment…", enterkeyhint: "done", "aria-label": "Comment", dataset: { comment: d.key } }));
  }
  if (d.place === core.EDIT_PLACE && d.found && !original) {
    parts.push(el("div", { class: "tools" },
      d.parentId ? el("a", { href: folderLink(d.parentId), target: "_blank", rel: "noopener", text: "📂 Folder" }) : null,
      d.isEditResult ? null : el("button", { text: "📋 Prompt", dataset: { prompt: d.key } })));
  }
  parts.push(el("div", { class: `meta${warn ? " warn" : ""}`, text: meta }));
  return el("article", { class: classes.join(" "), dataset: { key: d.key } }, parts);
}

// ------------------------------------------------------------------ the board
let shown = [];

function rebuildViewSelect() {
  const sel = $("view");
  const designs = [...state.designs.values()].filter((d) => !d.isOriginal);
  const count = (f) => designs.filter(f).length;
  const items = [
    [`Not assigned yet (${count((d) => !core.assigned(d) && d.found)})`, "unassigned"],
    [`Starred (${count((d) => d.starred)})`, "starred"],
    [`To be edited (${count((d) => d.place === core.EDIT_PLACE)})`, "edit"],
    [`All designs (${designs.length})`, "all"],
    ...state.shops.map((s) => [`In ${s.name} (${count((d) => d.place === s.name)})`, `shop:${s.name}`]),
  ];
  const missing = count((d) => !d.found);
  if (missing) items.push([`Not found (${missing})`, "missing"]);
  sel.replaceChildren(...items.map(([label, value]) => el("option", { value, text: label })));
  sel.value = items.some(([, v]) => v === settings.view) ? settings.view : "unassigned";
  settings.view = sel.value;
}

function render() {
  if (!state) return;
  rebuildViewSelect();
  const scrollY = window.scrollY;
  const strips = new Map([...document.querySelectorAll(".row")].map((r) => [r.dataset.row, r.querySelector(".strip")?.scrollLeft || 0]));
  const rows = core.buildRows([...state.designs.values()], settings.newestFirst);
  shown = core.visibleRows(rows, settings.view, $("search").value);
  const main = $("board");
  main.className = `bg-${settings.background}`;
  if (!shown.length) {
    let text = "Nothing matches this view.";
    if (!state.designs.size) text = "No designs yet.<br><br>Add PNG or JPG files to the Designs folder in Google Drive, then tap ↻.";
    else if (settings.view === "unassigned" && !$("search").value.trim()) text = "Every design has been assigned. 🎉<br><br>Choose <b>All designs</b> at the top to see them.";
    const panel = el("div", { class: "panel" });
    panel.innerHTML = text;
    main.replaceChildren(el("div", { class: "empty" }, panel));
  } else {
    main.replaceChildren(...shown.map(({ row, items }) => {
      const nVar = row.variants.length;
      let info;
      if (row.isOther) info = `${items.length} shown`;
      else if (!nVar) info = "original only, no variants yet";
      else info = row.originals.length ? `original + ${nVar} variant${nVar === 1 ? "" : "s"}` : `${nVar} variant${nVar === 1 ? "" : "s"}`;
      return el("section", { class: "row", dataset: { row: row.key } },
        el("div", { class: "row-head" }, el("h2", { text: row.title }), el("span", { class: "info", text: info }),
          el("button", { text: "View", dataset: { view: row.key } })),
        el("div", { class: "strip" }, items.map(card)));
    }));
    for (const r of main.querySelectorAll(".row")) {
      const left = strips.get(r.dataset.row);
      if (left) r.querySelector(".strip").scrollLeft = left;
    }
  }
  window.scrollTo(0, scrollY);
  const designs = [...state.designs.values()].filter((d) => !d.isOriginal);
  const nShown = shown.reduce((n, { items }) => n + items.filter((d) => !d.isOriginal).length, 0);
  $("foot").hidden = false;
  $("foot").textContent = `${shown.length} row${shown.length === 1 ? "" : "s"} · ${nShown} design${nShown === 1 ? "" : "s"} shown · ` +
    `${designs.length} in total · ${designs.filter((d) => d.starred).length} starred`;
  const notes = [];
  if (state.missingShops.length) notes.push(`Shop folders not found yet: <b>${state.missingShops.map(escapeHtml).join(", ")}</b>. <a href="#" data-open="settings">Settings</a>`);
  if (!state.shops.length) notes.push("No shops yet. Add them in the Windows app's Settings.");
  for (const p of state.problems.slice(0, 2)) notes.push(escapeHtml(p));
  $("notice").hidden = !notes.length;
  $("notice").innerHTML = notes.join("<br>");
  if (viewerOpen()) refreshViewer();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function load({ quiet = false } = {}) {
  if (loading || !board) return;
  loading = true;
  $("busy").hidden = false;
  if (!state) splash("Loading your designs…");
  else if (!quiet) { $("progress").hidden = false; $("progressText").textContent = "Refreshing…"; }
  try {
    const next = await board.load((msg) => {
      if (!state) splash(escapeHtml(msg));
      else if (!quiet) $("progressText").textContent = msg;
    });
    if (board.settingsChanged) { board.settingsChanged = false; }
    saveSettings();
    state = next;
    lastLoad = Date.now();
    hideSplash();
    $("bar").hidden = false;
    render();
  } catch (e) {
    handleError(e, { fatal: !state });
  } finally {
    loading = false;
    $("busy").hidden = busy === 0;
    $("progress").hidden = true;
  }
}

function handleError(e, { fatal = false } = {}) {
  console.error(e);
  if (e instanceof AuthError) {
    showSignIn("You've been signed out (Google asks again every so often). Tap below to carry on.");
    return;
  }
  const msg = e instanceof BoardError ? e.message : `Something went wrong: ${e.message || e}`;
  if (fatal) {
    splash(escapeHtml(msg), [
      el("button", { class: "btn primary", text: "Try again", onclick: () => load() }),
      el("button", { class: "btn", text: "Settings", onclick: () => openSettings() }),
    ]);
  } else {
    toast(msg, { error: true, ms: 9000 });
  }
}

async function act(fn) {
  setBusy(true);
  try { return await fn(); } catch (e) { handleError(e); render(); return null; } finally { setBusy(false); }
}

// ------------------------------------------------------------------ actions
async function onStar(key) {
  const d = state.designs.get(key);
  if (!d) return;
  await act(() => board.setStar(state, key, !d.starred));
  render();
}

async function onComment(key, value) {
  const d = state.designs.get(key);
  if (!d) return;
  const text = value.split(/\s+/).filter(Boolean).join(" ");
  if (text === d.comment) return;
  if (await act(() => board.setComment(state, key, text))) toast(text ? "Comment saved." : "Comment removed.", { ms: 2500 });
  render();
}

async function onPlace(key, place) {
  const d = state.designs.get(key);
  if (!d || place === d.place) return;
  const name = d.file;
  if (place === core.EDIT_PLACE) {
    let comment = d.comment;
    if (!comment) {
      comment = window.prompt(`What should be changed in “${name}”?\n(Saved as its comment and in its ChatGPT prompt)`, "");
      if (comment === null) { render(); return; }
    }
    const res = await act(() => board.sendToEdit(state, key, comment !== d.comment ? comment : null));
    render();
    if (res) {
      if (res.warning) toast(res.warning, { error: true, ms: 9000 });
      else toast(`Sent “${name}” to To be edited, with its original and a ChatGPT prompt.`, { action: () => undo(res.ev) });
    }
    return;
  }
  const ev = await act(() => board.move(state, key, place));
  render();
  if (ev) toast(`Moved “${name}” to ${place === core.UNASSIGNED ? "the Designs folder" : place}.`, { action: () => undo(ev) });
}

async function undo(ev) {
  const res = await act(() => board.undo(state, ev));
  render();
  if (res) toast(`Moved “${ev.new_file}” back.`, { ms: 3000 });
  if (!$("sheet").hidden && $("sheetTitle").textContent === "Move log") openLog();
}

async function copyPrompt(key) {
  const d = state.designs.get(key);
  if (!d) return;
  const text = d.sub ? board.promptFor(state, d.sub) : "";
  if (!text) { toast("There's no prompt for this design yet.", { error: true }); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("ChatGPT prompt copied. Paste it into ChatGPT with the two pictures from the folder.", { ms: 4500 });
  } catch {
    openSheet("ChatGPT prompt", el("div", {}, el("p", { class: "hint", text: "Press and hold to copy:" }),
      el("textarea", { style: "width:100%;height:50vh;font-size:15px", readonly: true }, text)));
  }
}

// ------------------------------------------------------------------ viewer: a row, big, swipe sideways
let viewerItems = [], viewerIndex = 0;
const viewerOpen = () => !$("viewer").hidden;

function openViewer(rowKey, key) {
  const entry = shown.find(({ row }) => row.key === rowKey);
  if (!entry) return;
  viewerItems = entry.items.map((d) => d.key);
  viewerIndex = Math.max(0, viewerItems.indexOf(key));
  const strip = $("viewerStrip");
  strip.replaceChildren(...viewerItems.map((k) => {
    const d = state.designs.get(k);
    const src = thumbUrl(d, 1600);
    return el("div", { class: "slide" }, el("div", { class: `stage bg-${settings.background}` },
      src ? el("img", { src, alt: d.file, referrerpolicy: "no-referrer", dataset: { key: d.key } }) : el("span", { class: "noimg", text: "Loading…" })));
  }));
  $("viewer").hidden = false;
  document.body.style.overflow = "hidden";
  requestAnimationFrame(() => { strip.scrollLeft = viewerIndex * strip.clientWidth; refreshViewer(); });
}

function closeViewer() {
  $("viewer").hidden = true;
  document.body.style.overflow = "";
  render();
}

function refreshViewer() {
  const key = viewerItems[viewerIndex];
  const d = state?.designs.get(key);
  if (!d) { closeViewer(); return; }
  const row = shown.find(({ items }) => items.some((x) => x.key === key))?.row;
  $("viewerTitle").textContent = `${row ? row.title : ""} · ${viewerIndex + 1} of ${viewerItems.length}`;
  const original = d.isOriginal && !core.assigned(d);
  const panel = $("viewerPanel");
  panel.replaceChildren(
    el("div", { class: "line1" },
      original ? null : el("button", { class: `star${d.starred ? " on" : ""}`, text: d.starred ? "★" : "☆", dataset: { star: d.key } }),
      el("span", { class: "name", text: d.file })),
    original ? el("div", { class: "orig-tag", text: "Original (reference)" }) : shopSelect(d),
    original ? null : el("input", { class: `comment${d.comment ? " filled" : ""}`, type: "text", value: d.comment,
      placeholder: "Add a comment…", enterkeyhint: "done", dataset: { comment: d.key } }),
    el("div", { class: "meta", text: describe(d)[0] }));
  // the real file, in full quality and with its transparency, for this picture and its neighbours
  for (const i of [viewerIndex, viewerIndex + 1, viewerIndex - 1]) {
    const k = viewerItems[i];
    const dd = k && state.designs.get(k);
    const img = $("viewerStrip").children[i]?.querySelector("img, .noimg");
    if (!dd || !img || img.dataset.full === "1" || !dd.found) continue;
    fullImage(dd).then((url) => {
      if (img.tagName === "IMG") { img.src = url; img.dataset.full = "1"; }
      else img.replaceWith(el("img", { src: url, alt: dd.file, dataset: { full: "1", key: dd.key } }));
    }).catch(() => {});
  }
}

// ------------------------------------------------------------------ sheets: menu, move log, settings
function openSheet(title, body) {
  $("sheetTitle").textContent = title;
  $("sheetBody").replaceChildren(body);
  $("sheet").hidden = false;
  $("sheetBack").hidden = false;
}
function closeSheet() {
  $("sheet").hidden = true;
  $("sheetBack").hidden = true;
}

function openMenu() {
  const item = (text, fn) => el("button", { class: "menu-item", text, onclick: () => { closeSheet(); fn(); } });
  openSheet("Design Board", el("div", {},
    item("↻  Refresh", () => load()),
    item("🕘  Move log (undo a move)", openLog),
    item(`🎨  Background: ${BACKGROUNDS[settings.background]}`, () => {
      const keys = Object.keys(BACKGROUNDS);
      settings.background = keys[(keys.indexOf(settings.background) + 1) % keys.length];
      saveSettings(); render(); toast(`Background: ${BACKGROUNDS[settings.background]}`, { ms: 1800 });
    }),
    item(settings.newestFirst ? "⇅  Showing newest rows first" : "⇅  Showing oldest rows first", () => {
      settings.newestFirst = !settings.newestFirst; saveSettings(); render();
    }),
    item("⚙️  Settings", openSettings),
    item("🚪  Sign out", () => { signOut(); state = null; showSignIn("Signed out."); }),
  ));
}

function openLog() {
  const evs = [...state.events].reverse().filter((e) => core.isMove(e) || e.action === core.COPY);
  const what = { move: "Moved", undo: "Moved back (undo)", copy: "Copied original" };
  const list = evs.slice(0, 200).map((e) => {
    const [ok] = e.action === core.MOVE ? core.undoStatus(state, e) : [false];
    let text = `${what[e.action] || e.action} ${e.file}`;
    if (e.new_file && e.new_file !== e.file) text += ` (now ${e.new_file})`;
    text += ` → ${e.to_place}${e.to_sub ? " / " + e.to_sub : ""}`;
    if (state.undone.has(e.id)) text += " (undone)";
    return el("div", { class: "log-item" },
      el("div", { class: "what" }, el("div", { text }), el("div", { class: "when", text: `${shortTime(e)} · ${e.user}` })),
      ok ? el("button", { text: "Undo", onclick: () => undo(e) }) : null);
  });
  openSheet("Move log", el("div", {},
    el("p", { class: "hint", text: "Every move by anyone, newest first. Undo puts the file back where it was. Files are never deleted." }),
    list.length ? list : el("p", { text: "No moves yet." })));
}

async function openSettings(first = false) {
  const body = el("div", {});
  const name = el("input", { type: "text", value: settings.userName, placeholder: "For example: Trevor", autocomplete: "given-name" });
  body.append(el("div", { class: "field" }, el("label", { text: "Your name" }), name,
    el("div", { class: "hint", text: "Shown in the move log. Use the same name as on your computer." })));

  const folderBox = el("div", { class: "field" }, el("label", { text: "Designs folder" }));
  const folderList = el("div", {}, el("div", { class: "hint", text: "Looking in your Google Drive…" }));
  const link = el("input", { type: "text", placeholder: "…or paste the folder's link from Google Drive" });
  folderBox.append(folderList, link);
  body.append(folderBox);
  let chosen = settings.designsFolderId;
  board.findDesignsFolders().then((found) => {
    if (!found.length) {
      folderList.replaceChildren(el("div", { class: "hint", text: "No Designs folder set up by the Windows app was found. Paste its link below." }));
      return;
    }
    if (!chosen) chosen = found[0].id;
    folderList.replaceChildren(...found.map((f) => {
      const radio = el("input", { type: "radio", name: "folder", value: f.id, checked: f.id === chosen });
      radio.addEventListener("change", () => { chosen = f.id; link.value = ""; });
      return el("label", { class: "choice" }, radio, el("span", { text: f.name }));
    }));
  }).catch((e) => folderList.replaceChildren(el("div", { class: "hint", text: e.message })));

  if (!first && state) {
    const shops = el("div", { class: "field" }, el("label", { text: "Shops" }));
    for (const s of state.shops) {
      const ok = !!settings.shopFolderIds[s.name];
      const input = ok ? null : el("input", { type: "text", placeholder: "Paste the shop folder's link" });
      if (input) input.addEventListener("change", () => {
        const id = idFromLink(input.value);
        if (id) { settings.shopFolderIds[s.name] = id; saveSettings(); toast(`Saved the folder for ${s.name}.`, { ms: 2500 }); }
      });
      shops.append(el("div", { class: "shop-line" }, el("span", { style: "flex:1", text: s.name }),
        el("span", { class: ok ? "ok" : "bad", text: ok ? "✓ Found" : "Not found" })), input);
    }
    shops.append(el("div", { class: "hint", text: "Shops are added in the Windows app; the phone finds their folders by itself." }));
    body.append(shops);
  }

  body.append(el("button", { class: "btn primary", style: "width:100%;margin-top:8px", text: first ? "Start" : "Save", onclick: () => {
    const n = name.value.trim();
    if (!n) { name.focus(); toast("Please enter your name.", { error: true, ms: 3000 }); return; }
    const pasted = idFromLink(link.value);
    if (link.value.trim() && !pasted) { toast("That doesn't look like a Google Drive folder link.", { error: true }); return; }
    const folder = pasted || chosen;
    if (!folder) { toast("Choose the Designs folder.", { error: true, ms: 3000 }); return; }
    if (folder !== settings.designsFolderId) settings.shopFolderIds = {};
    settings.userName = n;
    settings.designsFolderId = folder;
    saveSettings();
    board.settings = settings;
    closeSheet();
    state = null;
    load();
  } }));
  body.append(el("div", { class: "hint", style: "margin-top:12px", text: `This phone's log file: ${board.logName}` }));
  openSheet(first ? "Welcome!" : "Settings", body);
}

// ------------------------------------------------------------------ sign-in
function showSignIn(message = "") {
  $("bar").hidden = true;
  splash(`${message ? escapeHtml(message) + "<br><br>" : ""}Sign in with the Google account that has your design folders.`, [
    el("button", { class: "btn primary", text: "Sign in with Google", onclick: async () => {
      try {
        await signIn(settings.email);
        await start();
      } catch (e) {
        showSignIn(e.message || String(e));
      }
    } }),
  ]);
}

async function start() {
  drive = new Drive(savedToken);
  board = new PhoneBoard(drive, settings);
  if (!settings.email || !settings.userName) {
    try {
      const me = await drive.about();
      settings.email = me.user?.emailAddress || settings.email;
      if (!settings.userName) settings.userName = (me.user?.displayName || "").split(" ")[0];
      saveSettings();
    } catch (e) { if (e instanceof AuthError) return showSignIn(); }
  }
  if (!settings.designsFolderId) {
    splash("Almost there: tell Design Board who you are and where your designs are.");
    settings.userName = settings.userName || "";
    openSettings(true);
    return;
  }
  await load();
}

async function boot() {
  if (!CONFIG.clientId) {
    splash("Design Board is almost ready.<br><br>The Google sign-in still needs to be set up (the Client ID). Ask Claude to finish the setup.");
    return;
  }
  try {
    await initSignIn(CONFIG.clientId);
  } catch (e) {
    splash(escapeHtml(e.message), [el("button", { class: "btn primary", text: "Try again", onclick: () => location.reload() })]);
    return;
  }
  if (savedToken()) await start();
  else showSignIn();
}

// ------------------------------------------------------------------ wiring
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-star],[data-open],[data-view],[data-prompt]");
  if (!t || !state) return;
  if (t.dataset.star) onStar(t.dataset.star);
  else if (t.dataset.prompt) copyPrompt(t.dataset.prompt);
  else if (t.dataset.view) { const entry = shown.find(({ row }) => row.key === t.dataset.view); if (entry) openViewer(entry.row.key, entry.items[0].key); }
  else if (t.dataset.open === "settings") { e.preventDefault(); openSettings(); }
  else if (t.dataset.open) {
    const entry = shown.find(({ items }) => items.some((d) => d.key === t.dataset.open));
    if (entry) openViewer(entry.row.key, t.dataset.open);
  }
});
document.addEventListener("change", (e) => {
  const t = e.target;
  if (!state) return;
  if (t.matches("select.shop")) onPlace(t.dataset.key, t.value);
  else if (t.matches("input.comment")) onComment(t.dataset.comment, t.value);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && e.target.matches("input.comment")) e.target.blur();
  if (e.key === "Escape") { if (viewerOpen()) closeViewer(); else closeSheet(); }
});
document.addEventListener("error", (e) => {
  if (e.target.tagName === "IMG" && e.target.dataset.key) fallbackImage(e.target);
}, true);

$("view").addEventListener("change", () => { settings.view = $("view").value; saveSettings(); window.scrollTo(0, 0); render(); });
let searchTimer = 0;
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(render, 200); });
$("refreshBtn").addEventListener("click", () => load());
$("menuBtn").addEventListener("click", openMenu);
$("sheetClose").addEventListener("click", closeSheet);
$("sheetBack").addEventListener("click", closeSheet);
$("viewerClose").addEventListener("click", closeViewer);
$("viewerBg").addEventListener("click", () => {
  const keys = Object.keys(BACKGROUNDS);
  settings.background = keys[(keys.indexOf(settings.background) + 1) % keys.length];
  saveSettings();
  for (const s of document.querySelectorAll(".stage")) s.className = `stage bg-${settings.background}`;
  toast(BACKGROUNDS[settings.background], { ms: 1200 });
});
let viewerScrollTimer = 0;
$("viewerStrip").addEventListener("scroll", () => {
  clearTimeout(viewerScrollTimer);
  viewerScrollTimer = setTimeout(() => {
    const s = $("viewerStrip");
    const i = Math.round(s.scrollLeft / Math.max(1, s.clientWidth));
    if (i !== viewerIndex) { viewerIndex = i; refreshViewer(); }
  }, 80);
});

// keep up to date with your partner's changes
setInterval(() => {
  const typing = document.activeElement?.matches?.("input, select, textarea");
  if (state && document.visibilityState === "visible" && !busy && !viewerOpen() && $("sheet").hidden && !typing && Date.now() - lastLoad > 55000) {
    load({ quiet: true });
  }
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state && Date.now() - lastLoad > 30000 && !busy) load({ quiet: true });
});

// for the automated tests
window.__designBoard = { get state() { return state; }, get settings() { return settings; }, load, render };

boot();
