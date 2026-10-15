// The board on Google Drive: loading, and the same safe actions as the Windows app.
//
// Safety rules (same as the Windows app):
//  * Files are only ever moved inside Google Drive, never overwritten or deleted. If a name is taken,
//    " (2)" is added. The one copy made is of a row's original, into a design's To be edited folder.
//  * Every move is written to this device's log. If the log can't be written, the file is moved back.
//  * Every move can be undone.

import * as core from "./core.js";
import { FOLDER, DriveError } from "./drive.js";

export class BoardError extends Error {}

const keyOf = (f) => (f.sha1Checksum ? f.sha1Checksum.toLowerCase().slice(0, 16) : "");
const isFolder = (f) => f.mimeType === FOLDER;

function fileInfo(f, extra = {}) {
  return {
    id: f.id, name: f.name, parentId: (f.parents || [])[0] || "", key: keyOf(f), size: Number(f.size || 0),
    width: f.imageMediaMetadata?.width || 0, height: f.imageMediaMetadata?.height || 0,
    thumb: f.thumbnailLink || "", modified: Date.parse(f.modifiedTime || f.createdTime || 0) / 1000 || 0, ...extra,
  };
}

async function inBatches(items, size, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

export class PhoneBoard {
  /** settings: {userName, device, designsFolderId, shopFolderIds: {name: id}} (saved by the app) */
  constructor(drive, settings) {
    this.drive = drive;
    this.settings = settings;
    this.ids = { designs: settings.designsFolderId, data: "", edit: "" };
    this.subFolders = new Map();  // "place|sub" -> folder id
    this.ownLogId = "";
    this.queue = Promise.resolve();
    this.settingsChanged = false;
  }

  get logName() {
    return `log-${core.slug(this.settings.userName)}-${core.slug(this.settings.device)}.csv`;
  }

  // ------------------------------------------------------------------ setup helpers
  /** Designs folders that are already set up (they contain _Design Board/shops.csv), newest first. */
  async findDesignsFolders() {
    const found = await this.drive.search(`name = '${core.SHOPS_FILE}' and trashed = false`);
    const out = [];
    for (const f of found) {
      try {
        const data = await this.drive.get((f.parents || [])[0], "id,name,parents");
        if (data.name !== core.DATA_FOLDER) continue;
        const designs = await this.drive.get((data.parents || [])[0], "id,name,modifiedTime");
        out.push({ id: designs.id, name: designs.name, modified: f.modifiedTime });
      } catch { /* no access to a parent */ }
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return out.filter((x, i) => out.findIndex((y) => y.id === x.id) === i);
  }

  /** Find a shop's folder from its hint ("Tees Masterfile/1. Cotton Theory"), like the Windows app does. */
  async resolveHint(hint) {
    const parts = hint.split("/").map((p) => p.trim()).filter(Boolean);
    if (!parts.length) return "";
    const name = parts[parts.length - 1], parentName = parts[parts.length - 2];
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    const candidates = await this.drive.search(`name = '${esc(name)}' and mimeType = '${FOLDER}' and trashed = false`, "id,name,parents");
    for (const c of candidates) {
      if (!parentName) return c.id;
      try {
        const parent = await this.drive.get((c.parents || [])[0], "id,name");
        if (parent.name.toLowerCase() === parentName.toLowerCase()) return c.id;
      } catch { /* parent not visible */ }
    }
    return "";
  }

  // ------------------------------------------------------------------ loading
  async load(progress = () => {}) {
    const designsId = this.settings.designsFolderId;
    if (!designsId) throw new BoardError("Choose the Designs folder in Settings.");
    progress("Looking for designs…");
    let top;
    try {
      top = await this.drive.get(designsId, "id,name");
    } catch (e) {
      if (e instanceof DriveError && (e.status === 404 || e.status === 403)) {
        throw new BoardError("The Designs folder can't be opened with this Google account. Check you're signed in with the right account, or choose the folder again in Settings.");
      }
      throw e;
    }
    this.subFolders.clear();
    this.subFolders.set(`${core.UNASSIGNED}|`, designsId);
    const shopIds = new Set(Object.values(this.settings.shopFolderIds || {}));
    const observed = [];
    const index = new Map();  // "place|sub|name" (lower case) -> file info
    const problems = [];
    // the Designs folder and its sub-folders (not _Design Board, To be edited or shop folders)
    let queue = [{ id: designsId, sub: "" }];
    while (queue.length) {
      const level = await inBatches(queue, 4, async (q) => ({ q, files: await this.drive.children(q.id) }));
      queue = [];
      for (const { q, files } of level) {
        for (const f of files) {
          if (isFolder(f)) {
            if (q.sub === "" && f.name === core.DATA_FOLDER) { this.ids.data = f.id; continue; }
            if (q.sub === "" && f.name === core.EDIT_FOLDER) { this.ids.edit = f.id; continue; }
            if (/^[_.$~]/.test(f.name) || shopIds.has(f.id)) continue;
            const sub = q.sub ? `${q.sub}/${f.name}` : f.name;
            this.subFolders.set(`${core.UNASSIGNED}|${sub}`, f.id);
            queue.push({ id: f.id, sub });
            continue;
          }
          if (!core.isImage(f.name) || f.name.startsWith("~")) continue;
          const info = fileInfo(f);
          index.set(`${core.UNASSIGNED}|${q.sub}|${f.name}`.toLowerCase(), info);
          if (!info.key) { problems.push(`“${f.name}” is still uploading; it will appear when Drive has finished.`); continue; }
          observed.push({ key: info.key, file: f.name, sub: q.sub, fileId: f.id, parentId: info.parentId,
            added: info.modified, width: info.width, height: info.height, thumb: info.thumb });
        }
      }
    }

    // shared data: shops and everyone's logs
    progress("Reading stars, comments and moves…");
    let shops = [], events = [];
    if (this.ids.data) {
      const files = await this.drive.children(this.ids.data);
      const shopsFile = files.find((f) => f.name === core.SHOPS_FILE);
      const logs = files.filter((f) => /^log-.*\.csv$/i.test(f.name));
      const own = logs.find((f) => f.name.toLowerCase() === this.logName.toLowerCase());
      this.ownLogId = own ? own.id : "";
      const texts = await inBatches(logs, 4, (f) => this.drive.text(f.id).catch(() => ""));
      events = core.readEvents(texts);
      if (shopsFile) shops = core.readShops(await this.drive.text(shopsFile.id));
    } else {
      problems.push("This folder hasn't been set up by the Windows app yet (no “_Design Board” folder). Shops are added there.");
    }

    // where each shop's folder is (found once by its hint, then remembered)
    const ids = { ...(this.settings.shopFolderIds || {}) };
    for (const s of shops) {
      if (!ids[s.name] && s.hint) {
        progress(`Finding the folder for ${s.name}…`);
        const id = await this.resolveHint(s.hint).catch(() => "");
        if (id) { ids[s.name] = id; this.settingsChanged = true; }
      }
    }
    for (const name of Object.keys(ids)) if (!shops.some((s) => s.name === name)) delete ids[name];
    this.settings.shopFolderIds = ids;
    const missingShops = shops.filter((s) => !ids[s.name]).map((s) => s.name);

    // To be edited: each design's own folder
    const editFiles = [];
    if (this.ids.edit) {
      progress("Reading the To be edited folders…");
      this.subFolders.set(`${core.EDIT_PLACE}|`, this.ids.edit);
      const level = await this.drive.children(this.ids.edit);
      const subs = level.filter(isFolder);
      for (const f of level) if (!isFolder(f) && core.isImage(f.name)) editFiles.push(fileInfo(f, { sub: "" }));
      const inside = await inBatches(subs, 4, async (s) => ({ s, files: await this.drive.children(s.id) }));
      for (const { s, files } of inside) {
        this.subFolders.set(`${core.EDIT_PLACE}|${s.name}`, s.id);
        for (const f of files) if (!isFolder(f) && core.isImage(f.name)) editFiles.push(fileInfo(f, { sub: s.name }));
      }
      for (const f of editFiles) index.set(`${core.EDIT_PLACE}|${f.sub}|${f.name}`.toLowerCase(), f);
    }

    // shop folders that the logs put designs in
    const latest = new Map();
    for (const e of events) if (core.isMove(e)) latest.set(e.design, e);
    const needed = new Set();
    for (const e of latest.values()) {
      if (e.to_place !== core.UNASSIGNED && e.to_place !== core.EDIT_PLACE && ids[e.to_place]) needed.add(`${e.to_place}|${e.to_sub}`);
    }
    if (needed.size) progress("Reading shop folders…");
    await inBatches([...needed], 4, async (pair) => {
      const [place, sub] = pair.split("|");
      let folderId = ids[place];
      if (sub) {
        const sf = await this.drive.childNamed(folderId, sub, true).catch(() => null);
        if (!sf) return;
        folderId = sf.id;
      }
      this.subFolders.set(pair, folderId);
      const files = await this.drive.children(folderId).catch(() => []);
      for (const f of files) if (!isFolder(f)) index.set(`${place}|${sub}|${f.name}`.toLowerCase(), fileInfo(f));
    });

    const { designs, undone } = core.replay(observed, events,
      (place, sub, name) => index.get(`${place}|${sub}|${name}`.toLowerCase()) || null);

    // new images in a design's To be edited folder (ChatGPT's result): "edited versions"
    const tracked = new Set([...designs.values()].map((d) => `${d.place}|${d.sub}|${d.file}`.toLowerCase()));
    const copies = new Set(events.filter((e) => e.action === core.COPY).map((e) => `${core.EDIT_PLACE}|${e.to_sub}|${e.new_file}`.toLowerCase()));
    const known = new Set([...designs.keys()]);
    for (const d of designs.values()) {
      const f = index.get(`${d.place}|${d.sub}|${d.file}`.toLowerCase());
      if (f?.key) known.add(f.key);
    }
    const added = [];
    for (const f of editFiles) {
      const where = `${core.EDIT_PLACE}|${f.sub}|${f.name}`.toLowerCase();
      if (tracked.has(where) || copies.has(where) || !f.key || known.has(f.key) || f.name.startsWith("~")) continue;
      known.add(f.key);
      const d = core.makeDesign({ key: f.key, file: f.name, place: core.EDIT_PLACE, sub: f.sub, fileId: f.id,
        parentId: f.parentId, added: f.modified, width: f.width, height: f.height, thumb: f.thumb, isEditResult: true });
      designs.set(d.key, d);
      added.push(d);
    }
    for (const e of events) {
      const d = added.find((x) => x.key === e.design);
      if (!d) continue;
      if (e.action === core.STAR || e.action === core.UNSTAR) { d.starred = e.action === core.STAR; d.starredBy = e.user; }
      if (e.action === core.COMMENT) { d.comment = e.note; d.commentEvent = e; }
    }
    if (added.length) core.annotate([...designs.values()]);
    // pictures for designs that were saved over in their folder (edited in place)
    for (const d of designs.values()) {
      const f = index.get(`${d.place}|${d.sub}|${d.file}`.toLowerCase());
      if (f && d.place !== core.UNASSIGNED) {
        d.thumb = f.thumb || d.thumb; d.width = f.width || d.width; d.height = f.height || d.height;
      }
    }
    return { designs, events, undone, shops, missingShops, problems, folderName: top.name, loadedAt: Date.now() };
  }

  // ------------------------------------------------------------------ log
  event(action, d, fields = {}) {
    return { id: core.newId(), time: core.nowIso(), user: this.settings.userName.trim(), computer: this.settings.device,
      action, design: d.key, file: d.file, from_place: "", from_sub: "", to_place: "", to_sub: "", new_file: "",
      ref: "", note: "", ...fields };
  }

  /** Add one row to this device's own log file (one at a time, in order). */
  appendLog(ev) {
    const run = async () => {
      if (!this.ids.data) throw new BoardError("The shared “_Design Board” folder is missing. Open the Windows app once to set it up.");
      if (!this.ownLogId) {
        const existing = await this.drive.childNamed(this.ids.data, this.logName);
        if (existing) this.ownLogId = existing.id;
      }
      if (this.ownLogId) {
        const current = await this.drive.text(this.ownLogId);
        await this.drive.updateText(this.ownLogId, core.appendToLog(current, ev), "text/csv");
      } else {
        const created = await this.drive.createText(this.logName, this.ids.data, core.appendToLog("", ev), "text/csv");
        this.ownLogId = created.id;
      }
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  // ------------------------------------------------------------------ actions
  async setStar(state, key, on) {
    const d = state.designs.get(key);
    if (!d) throw new BoardError("That design is no longer on the board. Pull down to refresh.");
    if (on && d.isOriginal) throw new BoardError("Originals can't be starred; star one of its variants instead.");
    const ev = this.event(on ? core.STAR : core.UNSTAR, d, { from_place: d.place, from_sub: d.sub });
    await this.appendLog(ev).catch((e) => { throw new BoardError(`Could not save the star: ${e.message}`); });
    core.applyEvent(state, ev);
    return ev;
  }

  async setComment(state, key, text) {
    text = String(text || "").split(/\s+/).filter(Boolean).join(" ");
    const d = state.designs.get(key);
    if (!d) throw new BoardError("That design is no longer on the board. Pull down to refresh.");
    if (text === d.comment) return d.commentEvent;
    const ev = this.event(core.COMMENT, d, { from_place: d.place, from_sub: d.sub, note: text });
    await this.appendLog(ev).catch((e) => { throw new BoardError(`Could not save the comment: ${e.message}`); });
    core.applyEvent(state, ev);
    if (d.place === core.EDIT_PLACE && d.sub) await this.writePrompt(state, d.sub).catch(() => {});
    return ev;
  }

  async placeFolderId(place, { create = false } = {}) {
    if (place === core.UNASSIGNED) return this.settings.designsFolderId;
    if (place === core.EDIT_PLACE) {
      if (!this.ids.edit) {
        const existing = await this.drive.childNamed(this.settings.designsFolderId, core.EDIT_FOLDER, true);
        if (existing) this.ids.edit = existing.id;
        else if (create) this.ids.edit = (await this.drive.createFolder(core.EDIT_FOLDER, this.settings.designsFolderId)).id;
      }
      return this.ids.edit;
    }
    return (this.settings.shopFolderIds || {})[place] || "";
  }

  async subFolderId(place, base, sub, { create = false } = {}) {
    if (!sub) return base;
    const k = `${place}|${sub}`;
    if (this.subFolders.has(k)) return this.subFolders.get(k);
    let id = "";
    let parent = base;
    for (const part of sub.split("/")) {  // the Designs folder can have nested sub-folders
      const f = await this.drive.childNamed(parent, part, true);
      if (f) { parent = f.id; continue; }
      if (!create) return "";
      parent = (await this.drive.createFolder(part, parent)).id;
    }
    id = parent;
    this.subFolders.set(k, id);
    return id;
  }

  async freeName(folderId, wanted) {
    const taken = [];
    let name = wanted;
    for (;;) {
      const clash = await this.drive.childNamed(folderId, name);
      if (!clash) return name;
      taken.push(name);
      name = core.uniqueName(wanted, taken);
    }
  }

  async move(state, key, toPlace, { toSub = "", action = core.MOVE, ref = "", wantedName = null } = {}) {
    const d = state.designs.get(key);
    if (!d) throw new BoardError("That design is no longer on the board. Pull down to refresh.");
    if (!d.found || !d.fileId) {
      throw new BoardError(`“${d.file}” is not where the board expects it (it may have been moved outside the app, or Drive is still syncing). Refresh and try again.`);
    }
    if (toPlace === d.place && toSub === d.sub) throw new BoardError(`“${d.file}” is already there.`);
    if (action === core.MOVE && d.isOriginal && !core.assigned(d)) {
      throw new BoardError(`“${d.file}” is the original (reference) image for row ${d.rowLabel}. Only its variants (v1, v2, …) can be assigned to shops.`);
    }
    const base = await this.placeFolderId(toPlace, { create: toPlace === core.EDIT_PLACE });
    if (!base) throw new BoardError(`The folder for “${toPlace}” hasn't been found. Open Settings to choose it.`);
    let destId = base;
    if (toSub) {
      const sid = await this.subFolderId(toPlace, base, toSub);
      if (sid) destId = sid; else toSub = "";
    }
    if (wantedName === null && action === core.MOVE && d.isEditResult && toPlace !== core.EDIT_PLACE) wantedName = core.editedName(d);
    const newName = await this.freeName(destId, wantedName || d.file);
    const fromParent = d.parentId;
    try {
      await this.drive.move(d.fileId, fromParent, destId, newName !== d.file ? newName : null);
    } catch (e) {
      throw new BoardError(`Google Drive could not move “${d.file}” to ${toPlace}: ${e.message}`);
    }
    const ev = this.event(action, d, { from_place: d.place, from_sub: d.sub, to_place: toPlace, to_sub: toSub, new_file: newName, ref });
    try {
      await this.appendLog(ev);
    } catch (e) {
      try {
        await this.drive.move(d.fileId, destId, fromParent, newName !== d.file ? d.file : null);
      } catch {
        throw new BoardError(`“${d.file}” was moved to ${toPlace}, but the move log could not be written (${e.message}). Please move it back by hand.`);
      }
      throw new BoardError(`The move log could not be written, so nothing was moved: ${e.message}`);
    }
    core.applyEvent(state, ev, { parentId: destId });
    return ev;
  }

  originalOf(state, key) {
    const d = state.designs.get(key);
    if (!d || !d.inRow || d.isOriginal) return null;
    return [...state.designs.values()].find((o) => o.isOriginal && o.rowKey === d.rowKey && o.found && o.fileId) || null;
  }

  async copyOriginalForEdit(state, key) {
    const d = state.designs.get(key), o = this.originalOf(state, key);
    if (!d || !o) return null;
    const folder = await this.subFolderId(core.EDIT_PLACE, await this.placeFolderId(core.EDIT_PLACE, { create: true }), d.sub, { create: true });
    const name = core.originalCopyName(o.file, o.rowLabel);
    if (await this.drive.childNamed(folder, name)) return null;  // already there
    try {
      await this.drive.copy(o.fileId, name, folder);
    } catch (e) {
      throw new BoardError(`The design was sent to ${core.EDIT_PLACE}, but its original “${o.file}” could not be copied there: ${e.message}`);
    }
    const ev = this.event(core.COPY, o, { from_place: o.place, from_sub: o.sub, to_place: core.EDIT_PLACE, to_sub: d.sub, new_file: name });
    await this.appendLog(ev).catch(() => {});
    state.events.push(ev);
    return ev;
  }

  promptFor(state, sub) {
    const here = [...state.designs.values()].filter((d) => d.place === core.EDIT_PLACE && d.sub === sub);
    const main = here.filter((d) => !d.isEditResult);
    const list = main.length ? main : here;
    if (!list.length) return "";
    let copyName = null;
    for (const e of state.events) if (e.action === core.COPY && e.to_place === core.EDIT_PLACE && e.to_sub === sub) copyName = e.new_file;
    return core.promptText(list[0], copyName, [...list.slice(1), ...here.filter((d) => d.isEditResult)]);
  }

  async writePrompt(state, sub) {
    const text = this.promptFor(state, sub);
    if (!text || !sub) return "";
    const folder = this.subFolders.get(`${core.EDIT_PLACE}|${sub}`);
    if (!folder) return "";
    const body = core.promptFileText(text);
    try {
      const existing = await this.drive.childNamed(folder, core.PROMPT_FILE);
      if (existing) {
        if ((await this.drive.text(existing.id)) !== body) await this.drive.updateText(existing.id, body, "text/plain");
      } else {
        await this.drive.createText(core.PROMPT_FILE, folder, body, "text/plain");
      }
    } catch (e) {
      return `Could not write “${core.PROMPT_FILE}”: ${e.message}`;
    }
    return "";
  }

  /** Comment (if given), then move the design into its own To be edited folder with a copy of its original
   *  and a ChatGPT prompt. Returns {ev, warning}; the move is kept even if the copy or prompt fails. */
  async sendToEdit(state, key, comment = null) {
    const d = state.designs.get(key);
    if (!d) throw new BoardError("That design is no longer on the board. Pull down to refresh.");
    if (comment !== null) await this.setComment(state, key, comment);
    const sub = core.folderNameFor(d.file);
    const edit = await this.placeFolderId(core.EDIT_PLACE, { create: true });
    await this.subFolderId(core.EDIT_PLACE, edit, sub, { create: true });
    const ev = await this.move(state, key, core.EDIT_PLACE, { toSub: sub });
    const warnings = [];
    try { await this.copyOriginalForEdit(state, key); } catch (e) { warnings.push(e.message); }
    const w = await this.writePrompt(state, ev.to_sub);
    if (w) warnings.push(w);
    return { ev, warning: warnings.join("\n") };
  }

  async undo(state, ev) {
    const [ok, why] = core.undoStatus(state, ev);
    if (!ok) throw new BoardError(why);
    return this.move(state, ev.design, ev.from_place, { toSub: ev.from_sub, action: core.UNDO, ref: ev.id, wantedName: ev.file });
  }
}
