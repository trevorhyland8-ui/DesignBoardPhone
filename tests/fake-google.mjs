// A pretend Google Drive and Google sign-in, for testing the phone app in a real browser without a Google account.
// Implements just the Drive API v3 calls the app makes.

import { createHash } from "node:crypto";

export const FOLDER = "application/vnd.google-apps.folder";

export class FakeDrive {
  constructor() {
    this.files = new Map();
    this.n = 0;
    this.calls = [];
    this.failMovesTo = null;  // folder id: pretend Google refuses moves into it
  }

  add({ name, parent = null, folder = false, content = null, mimeType = null }) {
    const id = `id${(++this.n).toString().padStart(4, "0")}`;
    const data = content == null ? null : Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    this.files.set(id, {
      id, name, parents: parent ? [parent] : [], mimeType: folder ? FOLDER : (mimeType || guess(name)),
      data, modifiedTime: new Date(Date.now() - 1000 * (1000 - this.n)).toISOString(), trashed: false,
    });
    return id;
  }

  folder(name, parent = null) { return this.add({ name, parent, folder: true }); }

  byName(name, parent = undefined) {
    return [...this.files.values()].find((f) => f.name === name && (parent === undefined || f.parents[0] === parent)) || null;
  }

  childrenOf(id) { return [...this.files.values()].filter((f) => f.parents[0] === id && !f.trashed); }

  meta(f) {
    const out = { id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, modifiedTime: f.modifiedTime, createdTime: f.modifiedTime };
    if (f.data) {
      out.size = String(f.data.length);
      out.sha1Checksum = createHash("sha1").update(f.data).digest("hex");
    }
    if (/^image\//.test(f.mimeType)) {
      out.thumbnailLink = `https://lh3.googleusercontent.com/fake/${f.id}=s220`;
      out.imageMediaMetadata = { width: 300, height: 360 };
    }
    return out;
  }

  query(q) {
    let files = [...this.files.values()].filter((f) => !f.trashed);
    for (const clause of q.split(/ and /)) {
      let m;
      if ((m = /^'(.+)' in parents$/.exec(clause))) { const id = unesc(m[1]); files = files.filter((f) => f.parents.includes(id)); }
      else if ((m = /^name = '(.+)'$/.exec(clause))) { const n = unesc(m[1]); files = files.filter((f) => f.name === n); }
      else if ((m = /^mimeType = '(.+)'$/.exec(clause))) files = files.filter((f) => f.mimeType === m[1]);
      else if (clause === "trashed = false") { /* already */ }
      else throw new Error(`fake Drive doesn't understand: ${clause}`);
    }
    return files;
  }

  /** Handle one request from the browser. Returns {status, headers, body}. */
  handle(method, url, bodyBuf, headers) {
    const u = new URL(url);
    this.calls.push(`${method} ${u.pathname}${u.search}`);
    const json = (obj, status = 200) => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
    if ((headers.authorization || "") !== "Bearer test-token") return json({ error: { message: "Invalid Credentials" } }, 401);
    const p = u.pathname;
    let m;
    if (p === "/drive/v3/about") return json({ user: { displayName: "Trevor Hyland", emailAddress: "trevorhyland8@gmail.com" } });
    if (p === "/drive/v3/files" && method === "GET") {
      return json({ files: this.query(u.searchParams.get("q")).map((f) => this.meta(f)) });
    }
    if (p === "/drive/v3/files" && method === "POST") {
      const b = JSON.parse(bodyBuf.toString("utf8"));
      const id = this.add({ name: b.name, parent: b.parents[0], folder: b.mimeType === FOLDER });
      return json(this.meta(this.files.get(id)));
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(p)) && method === "POST") {
      const src = this.files.get(m[1]);
      if (!src) return json({ error: { message: "File not found" } }, 404);
      const b = JSON.parse(bodyBuf.toString("utf8"));
      const id = this.add({ name: b.name || `Copy of ${src.name}`, parent: b.parents[0], content: src.data, mimeType: src.mimeType });
      return json(this.meta(this.files.get(id)));
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
      const f = this.files.get(decodeURIComponent(m[1]));
      if (!f) return json({ error: { message: "File not found" } }, 404);
      if (method === "GET" && u.searchParams.get("alt") === "media") {
        return { status: 200, headers: { "content-type": f.mimeType }, body: f.data || Buffer.alloc(0) };
      }
      if (method === "GET") return json(this.meta(f));
      if (method === "PATCH") {
        const add = u.searchParams.get("addParents"), remove = u.searchParams.get("removeParents");
        if (add && add === this.failMovesTo) return json({ error: { message: "Insufficient permissions for this file" } }, 403);
        if (remove && !f.parents.includes(remove)) return json({ error: { message: "Parent not found" } }, 400);
        if (add) f.parents = [add];
        const b = bodyBuf && bodyBuf.length ? JSON.parse(bodyBuf.toString("utf8")) : {};
        if (b.name) f.name = b.name;
        return json(this.meta(f));
      }
    }
    if (p === "/upload/drive/v3/files" && method === "POST") {
      const ct = headers["content-type"] || "";
      const boundary = /boundary=(.+)$/.exec(ct)[1];
      const parts = bodyBuf.toString("latin1").split(`--${boundary}`).slice(1, -1);
      const meta = JSON.parse(Buffer.from(parts[0].split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""), "latin1").toString("utf8"));
      const content = Buffer.from(parts[1].split("\r\n\r\n").slice(1).join("\r\n\r\n").replace(/\r\n$/, ""), "latin1");
      const id = this.add({ name: meta.name, parent: meta.parents[0], content, mimeType: meta.mimeType });
      return json(this.meta(this.files.get(id)));
    }
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && method === "PATCH") {
      const f = this.files.get(m[1]);
      f.data = Buffer.from(bodyBuf);
      return json(this.meta(f));
    }
    return json({ error: { message: `fake Drive: no route for ${method} ${p}` } }, 404);
  }

  text(id) { return this.files.get(id).data.toString("utf8"); }

  pathOf(id) {
    const names = [];
    let f = this.files.get(id);
    while (f) { names.unshift(f.name); f = this.files.get(f.parents[0]); }
    return names.join("/");
  }
}

function unesc(s) { return s.replace(/\\'/g, "'").replace(/\\\\/g, "\\"); }

function guess(name) {
  const n = name.toLowerCase();
  if (n.endsWith(".png")) return "image/png";
  if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
  if (n.endsWith(".csv")) return "text/csv";
  if (n.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

/** Install the pretend Google on a Playwright page. */
export async function installFakeGoogle(context, drive, { appRoot, readFile, clientId = "test-client" }) {
  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,PATCH,OPTIONS" };
  await context.addInitScript(() => {
    window.google = { accounts: { oauth2: {
      initTokenClient(cfg) {
        return { requestAccessToken() { setTimeout(() => cfg.callback({ access_token: "test-token", expires_in: 3600, scope: "https://www.googleapis.com/auth/drive" }), 50); } };
      },
      hasGrantedAllScopes() { return true; },
      revoke(_t, done) { done && done(); },
    } } };
  });
  await context.route("https://accounts.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await context.route("https://www.googleapis.com/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors });
    const res = drive.handle(req.method(), req.url(), req.postDataBuffer() || Buffer.alloc(0), req.headers());
    return route.fulfill({ status: res.status, headers: { ...cors, ...res.headers }, body: res.body });
  });
  await context.route("https://lh3.googleusercontent.com/**", (route) => {
    const id = /fake\/([^=]+)=/.exec(route.request().url())?.[1];
    const f = drive.files.get(id);
    return route.fulfill({ status: f ? 200 : 404, headers: { ...cors, "content-type": f?.mimeType || "text/plain" }, body: f?.data || "" });
  });
  await context.route("https://app.test/**", async (route) => {
    let path = new URL(route.request().url()).pathname.replace(/^\/+/, "") || "index.html";
    if (path.endsWith("/")) path += "index.html";
    if (path === "config.js") {
      return route.fulfill({ status: 200, contentType: "text/javascript", body: `export const CONFIG = { clientId: ${JSON.stringify(clientId)} };` });
    }
    try {
      const body = await readFile(`${appRoot}/${path}`);
      const type = path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : path.endsWith(".html") ? "text/html"
        : path.endsWith(".jpg") ? "image/jpeg" : path.endsWith(".png") ? "image/png" : path.endsWith(".webmanifest") ? "application/manifest+json" : "application/octet-stream";
      return route.fulfill({ status: 200, contentType: type, body });
    } catch {
      return route.fulfill({ status: 404, body: "not found" });
    }
  });
}
