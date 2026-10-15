// Design Board (phone): logic shared with the Windows app.
//
// Everything here must match the Windows app exactly, because both read and write the same files in
// "_Design Board": shops.csv and one log-<name>-<device>.csv per person and device. Nothing in this file
// talks to Google; it is plain logic, tested in tests/core.test.mjs.

export const UNASSIGNED = "Designs folder";
export const EDIT_PLACE = "To be edited";
export const EDIT_FOLDER = "To be edited";
export const DATA_FOLDER = "_Design Board";
export const SHOPS_FILE = "shops.csv";
export const PROMPT_FILE = "ChatGPT prompt.txt";
export const RESERVED_PLACES = new Set([UNASSIGNED.toLowerCase(), EDIT_PLACE.toLowerCase()]);

export const STAR = "star", UNSTAR = "unstar", MOVE = "move", UNDO = "undo", COMMENT = "comment", COPY = "copy";
export const ACTIONS = new Set([STAR, UNSTAR, MOVE, UNDO, COMMENT, COPY]);
export const LOG_FIELDS = ["id", "time", "user", "computer", "action", "design", "file", "from_place", "from_sub",
  "to_place", "to_sub", "new_file", "ref", "note"];

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function ext(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i).toLowerCase() : "";
}

export function stem(name) {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}

export function isImage(name) {
  return IMAGE_EXTS.has(ext(name));
}

export function slug(text) {
  const s = String(text).replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return s || "user";
}

export function newId() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function nowIso(date = new Date()) {
  // same shape as the Windows app (6 digits after the seconds) so the logs sort the same everywhere
  return date.toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
}

export function eventTime(ev) {
  const t = Date.parse(ev.time.replace(/(\.\d{3})\d*Z$/, "$1Z"));
  return Number.isNaN(t) ? 0 : t;
}

// ------------------------------------------------------------------ CSV (same as Python's csv module)
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let row = [], field = "", i = 0, quoted = false;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { quoted = true; i++; continue; }
    if (c === ",") { row.push(field); field = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      row.push(field); field = "";
      rows.push(row); row = [];
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++; continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function csvField(value) {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvLine(values) {
  return values.map(csvField).join(",") + "\r\n";
}

export function rowsToObjects(rows) {
  if (!rows.length) return [];
  const header = rows[0];
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ------------------------------------------------------------------ shops and logs
export function readShops(text) {
  const out = [], seen = new Set();
  for (const row of rowsToObjects(parseCsv(text || ""))) {
    const name = (row.shop || "").trim();
    if (name && !seen.has(name.toLowerCase()) && !RESERVED_PLACES.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      out.push({ name, hint: (row.folder_hint || "").trim() });
    }
  }
  return out;
}

export function rowToEvent(row) {
  const v = Object.fromEntries(LOG_FIELDS.map((k) => [k, String(row[k] ?? "").trim()]));
  if (!v.id || !v.design || !ACTIONS.has(v.action) || !v.time) return null;
  if ((v.action === MOVE || v.action === UNDO) && (!v.to_place || !v.new_file)) return null;
  return v;
}

export function isMove(ev) {
  return ev.action === MOVE || ev.action === UNDO;
}

/** All rows from all log files (an array of CSV texts), oldest first, duplicates and damaged rows removed. */
export function readEvents(texts) {
  const byId = new Map();
  for (const text of texts) {
    for (const row of rowsToObjects(parseCsv(text || ""))) {
      const ev = rowToEvent(row);
      if (ev && !byId.has(ev.id)) byId.set(ev.id, ev);
    }
  }
  return [...byId.values()].sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : a.id < b.id ? -1 : 1));
}

/** The log file's new contents with one more row (adds the header, or upgrades an old header). */
export function appendToLog(existingText, ev) {
  const header = csvLine(LOG_FIELDS);
  if (!existingText || !existingText.replace(/^﻿/, "").trim()) {
    return "﻿" + header + csvLine(LOG_FIELDS.map((k) => ev[k] ?? ""));
  }
  let text = existingText.startsWith("﻿") ? existingText : "﻿" + existingText;
  const rows = parseCsv(text);
  const current = rows[0] || [];
  if (current.join(",") !== LOG_FIELDS.join(",")) {
    const objects = rowsToObjects(rows);
    text = "﻿" + header + objects.map((o) => csvLine(LOG_FIELDS.map((k) => o[k] ?? ""))).join("");
  }
  if (!/[\r\n]$/.test(text)) text += "\r\n";
  return text + csvLine(LOG_FIELDS.map((k) => ev[k] ?? ""));
}

// ------------------------------------------------------------------ rows: 0297.jpg + 0297-v1.png, 0297-v2.png…
const VARIANT = /^(.+?)[\s_.-]+v(\d+)(?=$|[\s_.()-])/i;
const COPY_SUFFIX = /\s*\(\d+\)$/;

export function parseName(fileName) {
  const s = stem(fileName).trim();
  const m = VARIANT.exec(s);
  if (m) return { row: m[1].trim(), variant: parseInt(m[2], 10) };
  return { row: s.replace(COPY_SUFFIX, "").trim(), variant: null };
}

export function naturalKey(text) {
  return String(text).toLowerCase().split(/(\d+)/).filter((p) => p !== "")
    .map((p) => (/^\d+$/.test(p) ? [0, parseInt(p, 10), ""] : [1, 0, p]));
}

export function compareNatural(a, b) {
  const ka = naturalKey(a), kb = naturalKey(b);
  for (let i = 0; i < Math.min(ka.length, kb.length); i++) {
    for (let j = 0; j < 3; j++) {
      if (ka[i][j] < kb[i][j]) return -1;
      if (ka[i][j] > kb[i][j]) return 1;
    }
  }
  return ka.length - kb.length;
}

const isDigits = (s) => /^\d+$/.test(s);

/** Set rowKey, rowLabel, variant, isOriginal, inRow on every design (again after any rename). */
export function annotate(designs) {
  const parts = new Map();
  for (const d of designs) {
    let p = parseName(d.file);
    if (d.isEditResult && p.variant === null && d.sub) {
      const fromFolder = parseName(d.sub);  // ChatGPT's file in To be edited/0312-v1/ belongs to row 0312
      if (fromFolder.variant !== null || isDigits(fromFolder.row)) p = fromFolder;
    }
    parts.set(d, p);
  }
  const hasVariants = new Set([...parts.values()].filter((p) => p.variant !== null).map((p) => p.row.toLowerCase()));
  for (const d of designs) {
    const p = parts.get(d);
    d.rowKey = p.row.toLowerCase();
    d.rowLabel = p.row;
    d.variant = p.variant;
    d.isOriginal = !d.isEditResult && p.variant === null && (hasVariants.has(d.rowKey) || isDigits(p.row));
    d.inRow = d.isOriginal || p.variant !== null || (!!d.isEditResult && isDigits(p.row));
  }
}

export const OTHER_KEY = "~other";

export function buildRows(designs, newestFirst = true) {
  const rows = new Map();
  for (const d of designs) {
    const key = d.inRow ? d.rowKey : OTHER_KEY;
    if (!rows.has(key)) rows.set(key, { key, label: d.inRow ? d.rowLabel : "Other designs", items: [] });
    rows.get(key).items.push(d);
  }
  for (const row of rows.values()) {
    if (row.key === OTHER_KEY) {
      row.items.sort((a, b) => compareNatural(a.file, b.file) * (newestFirst ? -1 : 1));
    } else {
      row.items.sort((a, b) =>
        (a.isOriginal === b.isOriginal ? 0 : a.isOriginal ? -1 : 1)
        || ((a.variant ?? -1) - (b.variant ?? -1))
        || ((a.isEditResult ? 1 : 0) - (b.isEditResult ? 1 : 0))
        || compareNatural(a.file, b.file));
    }
  }
  const ordered = [...rows.values()].filter((r) => r.key !== OTHER_KEY)
    .sort((a, b) => compareNatural(a.label, b.label) * (newestFirst ? -1 : 1));
  if (rows.has(OTHER_KEY)) ordered.push(rows.get(OTHER_KEY));
  for (const r of ordered) {
    r.isOther = r.key === OTHER_KEY;
    r.title = r.isOther ? "Other designs" : `Row ${r.label}`;
    r.originals = r.items.filter((d) => d.isOriginal);
    r.variants = r.items.filter((d) => !d.isOriginal);
  }
  return ordered;
}

export function assigned(d) {
  return d.place !== UNASSIGNED;
}

export function matchesView(d, view, text) {
  if (view === "unassigned" && (assigned(d) || !d.found)) return false;
  if (view === "starred" && !d.starred) return false;
  if (view === "edit" && d.place !== EDIT_PLACE) return false;
  if (view === "missing" && d.found) return false;
  if (view.startsWith("shop:") && d.place !== view.slice(5)) return false;
  if (text && !d.file.toLowerCase().includes(text)) return false;
  return true;
}

export function visibleRows(rows, view, text = "") {
  text = text.trim().toLowerCase();
  const out = [];
  for (const row of rows) {
    const variants = row.variants.filter((d) => matchesView(d, view, text));
    const originals = row.originals.filter((d) => d.found);
    if (variants.length) out.push({ row, items: [...originals, ...variants] });
    else if (!row.variants.length && originals.length && (view === "unassigned" || view === "all")
             && (!text || originals.some((d) => d.file.toLowerCase().includes(text)))) {
      out.push({ row, items: originals });
    }
  }
  return out;
}

// ------------------------------------------------------------------ replaying the logs
/**
 * Work out the board from what is in the Designs folder plus everyone's logs (same rules as the Windows app).
 *   observed: [{key, file, sub, fileId, parentId, added, width, height, thumb}] seen in the Designs folder
 *   locate(place, sub, fileName): the Drive file at that place now, or null
 * Returns {designs: Map(key -> design), undone: Set(event id)}.
 */
export function replay(observed, events, locate) {
  const stars = new Map(), comments = new Map(), lastMove = new Map(), undone = new Set();
  for (const e of events) {
    if (e.action === STAR) stars.set(e.design, [true, e.user]);
    else if (e.action === UNSTAR) stars.set(e.design, [false, e.user]);
    else if (e.action === COMMENT) comments.set(e.design, e);
    else if (isMove(e)) {
      lastMove.set(e.design, e);
      if (e.action === UNDO && e.ref) undone.add(e.ref);
    }
  }
  const designs = new Map();
  const sorted = [...observed].sort((a, b) => (`${a.sub}/${a.file}`.toLowerCase() < `${b.sub}/${b.file}`.toLowerCase() ? -1 : 1));
  for (const o of sorted) {
    if (designs.has(o.key)) continue;  // an exact copy: shown once
    designs.set(o.key, makeDesign({ ...o, place: UNASSIGNED, found: true, lastMove: lastMove.get(o.key) || null }));
  }
  const byPlace = new Map();
  for (const d of designs.values()) byPlace.set(`${d.place}|${d.sub}|${d.file}`.toLowerCase(), d);
  const carried = new Map();
  for (const [key, e] of lastMove) {
    if (designs.has(key)) continue;
    const here = byPlace.get(`${e.to_place}|${e.to_sub}|${e.new_file}`.toLowerCase());
    if (here) {  // moved back into the Designs folder after it was edited: same design, new contents
      if (!here.lastMove || eventTime(here.lastMove) < eventTime(e)) here.lastMove = e;
      carried.set(key, here.key);
      continue;
    }
    const f = locate(e.to_place, e.to_sub, e.new_file);
    designs.set(key, makeDesign({
      key, file: e.new_file, place: e.to_place, sub: e.to_sub, found: !!f, added: eventTime(e) / 1000,
      fileId: f?.id || "", parentId: f?.parentId || "", width: f?.width || 0, height: f?.height || 0,
      thumb: f?.thumb || "", lastMove: e,
      edited: !!f && !!f.key && f.key !== key,
    }));
  }
  for (const [key, [on, user]] of stars) {
    const d = designs.get(key) || designs.get(carried.get(key));
    if (d && (d.key === key || (carried.has(key) && !stars.has(d.key)))) { d.starred = on; d.starredBy = user; }
  }
  for (const [key, e] of comments) {
    const d = designs.get(key) || designs.get(carried.get(key));
    if (d && (d.key === key || !d.commentEvent || eventTime(d.commentEvent) < eventTime(e))) {
      d.comment = e.note; d.commentEvent = e;
    }
  }
  annotate([...designs.values()]);
  return { designs, undone };
}

export function makeDesign(fields) {
  return {
    key: "", file: "", place: UNASSIGNED, sub: "", fileId: "", parentId: "", found: true, added: 0,
    width: 0, height: 0, thumb: "", starred: false, starredBy: "", comment: "", commentEvent: null,
    lastMove: null, edited: false, isEditResult: false,
    rowKey: "", rowLabel: "", variant: null, isOriginal: false, inRow: false,
    ...fields,
  };
}

export function readyForReview(d) {
  return d.place === EDIT_PLACE && (d.edited || d.isEditResult);
}

/** Apply one of this device's own actions to the board without reloading everything. */
export function applyEvent(state, ev, fileAfter = null) {
  state.events.push(ev);
  const d = state.designs.get(ev.design);
  if (!d) return null;
  if (ev.action === STAR || ev.action === UNSTAR) { d.starred = ev.action === STAR; d.starredBy = ev.user; }
  else if (ev.action === COMMENT) { d.comment = ev.note; d.commentEvent = ev; }
  else if (isMove(ev)) {
    d.place = ev.to_place; d.sub = ev.to_sub; d.file = ev.new_file; d.lastMove = ev;
    if (fileAfter) { d.parentId = fileAfter.parentId; d.found = true; }
    if (ev.action === UNDO && ev.ref) state.undone.add(ev.ref);
    annotate([...state.designs.values()]);
  }
  return d;
}

export function undoStatus(state, ev) {
  if (ev.action !== MOVE) return [false, "Only moves can be undone."];
  if (state.undone.has(ev.id)) return [false, "This move has already been undone."];
  const d = state.designs.get(ev.design);
  if (!d || !d.lastMove || d.lastMove.id !== ev.id) return [false, "This design was moved again later. Undo the later move first."];
  if (d.place !== ev.to_place || !d.found) return [false, "The design is not where this move put it (it may still be syncing). Try Refresh."];
  return [true, ""];
}

// ------------------------------------------------------------------ To be edited
export function folderNameFor(fileName) {
  return stem(fileName).trim().replace(/\.+$/, "") || "design";
}

export function originalCopyName(originalFile, rowLabel) {
  return `${rowLabel} original${ext(originalFile) || ".jpg"}`;
}

export function editedName(d) {
  // ChatGPT's file name ("ChatGPT Image Oct 14…png") becomes e.g. "0312-v1-edited.png" when it leaves its folder
  if (parseName(d.file).variant === null && d.sub) return `${d.sub}-edited${ext(d.file)}`;
  return null;
}

export function promptText(design, originalCopy, more = []) {
  const isPng = design.file.toLowerCase().endsWith(".png");
  const size = design.width && design.height ? `${design.width} × ${design.height} px` : "";
  const kind = isPng ? "transparent PNG" : "image";
  const lines = ["Please edit the attached t-shirt design.", "", "Files:"];
  lines.push(`• ${design.file} – the design to edit (${kind}${size ? ", " + size : ""})`);
  if (originalCopy) lines.push(`• ${originalCopy} – the original inspiration, for reference only`);
  lines.push("", "Changes to make:");
  const changes = design.comment ? [design.comment] : [];
  for (const d of more) if (d.comment && !changes.includes(d.comment)) changes.push(d.comment);
  if (changes.length) changes.forEach((c) => lines.push(`• ${c}`));
  else lines.push("• (no comment yet: add one in Design Board)");
  let keep = "Keep everything else the same: the art style, colours and layout";
  if (isPng) keep += ", with a fully transparent background";
  if (size) keep += `, at the same size (${size})`;
  lines.push("", keep + ".");
  lines.push(isPng ? "Give me the edited design as a PNG with a transparent background, ready to print on a shirt."
                   : "Give me the edited design at the same quality, ready to print on a shirt.");
  return lines.join("\n") + "\n";
}

/** Exactly the bytes the Windows app writes for the prompt file (UTF-8 with BOM, Windows line endings). */
export function promptFileText(text) {
  return "﻿" + text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

export function uniqueName(name, taken) {
  const lower = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  const s = stem(name), e = name.slice(s.length);
  for (let n = 2; ; n++) {
    const cand = `${s} (${n})${e}`;
    if (!lower.has(cand.toLowerCase())) return cand;
  }
}
