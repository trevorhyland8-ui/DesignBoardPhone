// Google sign-in (in the browser, no server) and the few Google Drive calls the app needs.

export const SCOPE = "https://www.googleapis.com/auth/drive";
const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
export const FILE_FIELDS = "id,name,mimeType,parents,size,sha1Checksum,modifiedTime,createdTime," +
  "imageMediaMetadata(width,height),thumbnailLink";
export const FOLDER = "application/vnd.google-apps.folder";

export class AuthError extends Error {}
export class DriveError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// ------------------------------------------------------------------ sign-in (Google Identity Services)
const TOKEN_KEY = "designboard.token";
let tokenClient = null;
let pending = null;

export function savedToken() {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || "null");
    return t && t.expires > Date.now() ? t.token : null;
  } catch { return null; }
}

function waitForGoogle(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) return resolve(window.google);
      if (Date.now() - start > timeoutMs) return reject(new Error("Google sign-in didn't load. Check the internet connection and try again."));
      setTimeout(check, 100);
    })();
  });
}

export async function initSignIn(clientId) {
  const google = await waitForGoogle();
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPE,
    callback: (resp) => {
      const p = pending; pending = null;
      if (resp.error) return p?.reject(new AuthError(resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPE)) {
        return p?.reject(new AuthError("Design Board needs permission to see and move your Google Drive files. Please tick the box when Google asks."));
      }
      const expires = Date.now() + (Number(resp.expires_in || 3600) - 120) * 1000;
      try { sessionStorage.setItem(TOKEN_KEY, JSON.stringify({ token: resp.access_token, expires })); } catch { /* private mode */ }
      try { localStorage.setItem("designboard.consented", "1"); } catch { /* ignore */ }
      p?.resolve(resp.access_token);
    },
    error_callback: (err) => {
      const p = pending; pending = null;
      p?.reject(new AuthError(err?.type === "popup_closed" ? "Sign-in was closed before it finished." : (err?.message || "Sign-in failed.")));
    },
  });
}

/** Must be called from a tap (browsers only allow the Google window then). */
export function signIn(email = "") {
  if (!tokenClient) return Promise.reject(new AuthError("Sign-in isn't ready yet."));
  let consented = false;
  try { consented = localStorage.getItem("designboard.consented") === "1"; } catch { /* ignore */ }
  return new Promise((resolve, reject) => {
    pending = { resolve, reject };
    tokenClient.requestAccessToken({ prompt: consented ? "" : "consent", login_hint: email || undefined });
  });
}

export function signOut() {
  const t = savedToken();
  try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
  if (t && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(t, () => {});
}

// ------------------------------------------------------------------ Drive
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

export class Drive {
  constructor(getToken = savedToken) {
    this.getToken = getToken;
  }

  async request(url, options = {}, { raw = false, tries = 3 } = {}) {
    const token = this.getToken();
    if (!token) throw new AuthError("Signed out");
    for (let attempt = 1; ; attempt++) {
      let res;
      try {
        res = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
      } catch (e) {
        if (attempt < tries) { await sleep(600 * attempt); continue; }
        throw new DriveError("No connection to Google Drive. Check the internet connection.", 0);
      }
      if (res.status === 401) {
        try { sessionStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
        throw new AuthError("Signed out");
      }
      if ((res.status === 429 || res.status >= 500) && attempt < tries) { await sleep(800 * attempt); continue; }
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).error?.message || msg; } catch { /* not JSON */ }
        throw new DriveError(msg, res.status);
      }
      if (raw) return res;
      if (res.status === 204) return null;
      return res.json();
    }
  }

  async list(q, fields = FILE_FIELDS) {
    const out = [];
    let pageToken = "";
    do {
      const params = new URLSearchParams({
        q, fields: `nextPageToken,files(${fields})`, pageSize: "1000", spaces: "drive",
        supportsAllDrives: "true", includeItemsFromAllDrives: "true",
      });
      if (pageToken) params.set("pageToken", pageToken);
      const data = await this.request(`${API}/files?${params}`);
      out.push(...(data.files || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);
    return out;
  }

  children(folderId) {
    return this.list(`'${esc(folderId)}' in parents and trashed = false`);
  }

  async childNamed(folderId, name, folderOnly = false) {
    const q = `'${esc(folderId)}' in parents and name = '${esc(name)}' and trashed = false` +
      (folderOnly ? ` and mimeType = '${FOLDER}'` : "");
    return (await this.list(q))[0] || null;
  }

  get(id, fields = FILE_FIELDS) {
    return this.request(`${API}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`);
  }

  async text(id) {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {}, { raw: true });
    const buf = await res.arrayBuffer();
    return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);  // keeps a leading byte-order mark as
  }

  async blob(id) {
    const res = await this.request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, {}, { raw: true });
    return res.blob();
  }

  /** Move a file to another folder (and rename it if newName is given). Never copies or deletes. */
  move(id, fromParent, toParent, newName = null) {
    const params = new URLSearchParams({ addParents: toParent, removeParents: fromParent, fields: FILE_FIELDS, supportsAllDrives: "true" });
    return this.request(`${API}/files/${encodeURIComponent(id)}?${params}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(newName ? { name: newName } : {}),
    });
  }

  createFolder(name, parent) {
    return this.request(`${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [parent], mimeType: FOLDER }),
    });
  }

  copy(id, name, parent) {
    return this.request(`${API}/files/${encodeURIComponent(id)}/copy?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parents: [parent] }),
    });
  }

  createText(name, parent, text, mimeType = "text/plain") {
    const boundary = "db" + Math.random().toString(16).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
      JSON.stringify({ name, parents: [parent], mimeType }),
      `\r\n--${boundary}\r\nContent-Type: ${mimeType}; charset=UTF-8\r\n\r\n`,
      text,
      `\r\n--${boundary}--`,
    ]);
    return this.request(`${UPLOAD}/files?uploadType=multipart&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
    });
  }

  updateText(id, text, mimeType = "text/plain") {
    return this.request(`${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`, {
      method: "PATCH", headers: { "Content-Type": `${mimeType}; charset=UTF-8` }, body: new Blob([text]),
    });
  }

  about() {
    return this.request(`${API}/about?fields=${encodeURIComponent("user(displayName,emailAddress)")}`);
  }

  search(q, fields = FILE_FIELDS) {
    return this.list(q, fields);
  }
}

export function folderLink(id) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`;
}

export function idFromLink(text) {
  const s = String(text || "").trim();
  const m = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(s) ? s : "";
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
