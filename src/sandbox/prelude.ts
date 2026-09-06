/**
 * The sandbox's Medium host API surface, evaluated once per invocation
 * before the tool's own code. Everything here is either:
 *  - pure computation (Buffer, TextEncoder/Decoder, URL/URLSearchParams,
 *    atob/btoa, AbortController, Blob, FormData, formatDate) — no host call
 *    needed, so these are plain JS classes/functions; or
 *  - a thin wrapper over one of the low-level `__bridge_*` functions
 *    registered by host-functions.ts (fetch, datastore, parsers, sleep,
 *    console, crypto) — every one of those is JSON-string in, JSON-string
 *    (or thrown error) out, per bridge.ts.
 *
 * Known, deliberate simplifications (documented, not silent):
 *  - `crypto.randomUUID`/`getRandomValues` are ASYNC here (must `await`),
 *    unlike the real synchronous Web Crypto API — true randomness needs a
 *    real host entropy source, which means crossing the bridge.
 *  - `AbortController`/`AbortSignal` are a real but "cosmetic" polyfill: a
 *    signal can be checked/thrown-on synchronously, but aborting it does
 *    not cancel an in-flight host `fetch` already underway. The per-
 *    invocation wall-time cap is the actual backstop for a hung call.
 *  - `FormData` is a real data structure but `fetch` does not encode it as
 *    multipart/form-data — a tool needing genuine multipart upload isn't
 *    fully supported yet.
 *
 * Nothing else is reachable: no `process`, no filesystem, no host `require`.
 */

export const SANDBOX_PRELUDE = String.raw`
"use strict";

// ---- base64 / hex codecs (pure; shared by Buffer, atob/btoa, fetch bodies) ----

const __B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function __bytesToBase64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += __B64_CHARS[b0 >> 2];
    out += __B64_CHARS[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? "=" : __B64_CHARS[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? "=" : __B64_CHARS[b2 & 0x3f];
  }
  return out;
}

function __base64ToBytes(b64) {
  const clean = String(b64).replace(/[^A-Za-z0-9+/]/g, "");
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = __B64_CHARS.indexOf(clean[i]);
    const c1 = __B64_CHARS.indexOf(clean[i + 1]);
    const c2 = __B64_CHARS.indexOf(clean[i + 2]);
    const c3 = __B64_CHARS.indexOf(clean[i + 3]);
    bytes.push((c0 << 2) | (c1 >> 4));
    if (c2 >= 0) bytes.push(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c3 >= 0) bytes.push(((c2 & 0x03) << 6) | c3);
  }
  return new Uint8Array(bytes);
}

function __bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function __hexToBytes(hex) {
  const clean = String(hex).replace(/[^0-9a-fA-F]/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  return bytes;
}

// ---- UTF-8 (pure; TextEncoder/TextDecoder + Buffer('utf8')) ----

function __utf8Encode(str) {
  const bytes = [];
  for (const ch of String(str)) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function __utf8Decode(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  let i = 0;
  while (i < arr.length) {
    const b0 = arr[i];
    let cp, len;
    if (b0 < 0x80) { cp = b0; len = 1; }
    else if ((b0 & 0xe0) === 0xc0) { cp = b0 & 0x1f; len = 2; }
    else if ((b0 & 0xf0) === 0xe0) { cp = b0 & 0x0f; len = 3; }
    else if ((b0 & 0xf8) === 0xf0) { cp = b0 & 0x07; len = 4; }
    else { cp = 0xfffd; len = 1; }
    for (let k = 1; k < len && i + k < arr.length; k++) cp = (cp << 6) | (arr[i + k] & 0x3f);
    out += String.fromCodePoint(cp);
    i += len;
  }
  return out;
}

class TextEncoder {
  encode(str) { return __utf8Encode(str ?? ""); }
}
class TextDecoder {
  constructor(encoding) { this.encoding = encoding || "utf-8"; }
  decode(bytes) { return bytes ? __utf8Decode(bytes) : ""; }
}
globalThis.TextEncoder = TextEncoder;
globalThis.TextDecoder = TextDecoder;

// ---- atob / btoa (pure) ----

globalThis.btoa = (str) => __bytesToBase64(Uint8Array.from(String(str), (c) => c.charCodeAt(0) & 0xff));
globalThis.atob = (b64) => {
  const bytes = __base64ToBytes(b64);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
};

// ---- Buffer (minimal; utf8/base64/hex only) ----

class Buffer extends Uint8Array {
  static from(data, encoding) {
    if (typeof data === "string") {
      if (encoding === "base64") return new Buffer(__base64ToBytes(data));
      if (encoding === "hex") return new Buffer(__hexToBytes(data));
      return new Buffer(__utf8Encode(data));
    }
    return new Buffer(data);
  }
  static isBuffer(x) { return x instanceof Buffer; }
  static byteLength(data, encoding) { return Buffer.from(data, encoding).length; }
  toString(encoding) {
    if (encoding === "base64") return __bytesToBase64(this);
    if (encoding === "hex") return __bytesToHex(this);
    return __utf8Decode(this);
  }
}
globalThis.Buffer = Buffer;

// ---- URL / URLSearchParams (pure) ----

class URLSearchParams {
  constructor(init) {
    this._entries = [];
    if (typeof init === "string") {
      const s = init.startsWith("?") ? init.slice(1) : init;
      for (const pair of s.split("&")) {
        if (!pair) continue;
        // Split on the *first* "=" only — a value containing "=" (e.g. a
        // base64/JWT token) must not be truncated at a later "=".
        const eqIndex = pair.indexOf("=");
        const k = eqIndex === -1 ? pair : pair.slice(0, eqIndex);
        const v = eqIndex === -1 ? "" : pair.slice(eqIndex + 1);
        this._entries.push([decodeURIComponent(k), decodeURIComponent(v)]);
      }
    } else if (init && typeof init === "object") {
      for (const [k, v] of (init instanceof URLSearchParams ? init._entries : Object.entries(init))) {
        this._entries.push([String(k), String(v)]);
      }
    }
  }
  append(k, v) { this._entries.push([String(k), String(v)]); }
  set(k, v) { this._entries = this._entries.filter(([key]) => key !== String(k)); this._entries.push([String(k), String(v)]); }
  get(k) { const e = this._entries.find(([key]) => key === String(k)); return e ? e[1] : null; }
  getAll(k) { return this._entries.filter(([key]) => key === String(k)).map(([, v]) => v); }
  has(k) { return this._entries.some(([key]) => key === String(k)); }
  delete(k) { this._entries = this._entries.filter(([key]) => key !== String(k)); }
  entries() { return this._entries[Symbol.iterator](); }
  forEach(fn) { this._entries.forEach(([k, v]) => fn(v, k)); }
  toString() { return this._entries.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&"); }
  [Symbol.iterator]() { return this._entries[Symbol.iterator](); }
}
globalThis.URLSearchParams = URLSearchParams;

const __URL_RE = /^([a-zA-Z][a-zA-Z0-9+.-]*:)\/\/(?:([^@/]*)@)?([^/:?#]*)(?::(\d+))?([^?#]*)(\?[^#]*)?(#.*)?$/;

class URL {
  constructor(input, base) {
    let full = String(input);
    if (base && !__URL_RE.test(full)) {
      const b = String(base).replace(/\/[^/]*$/, "/");
      full = full.startsWith("/") ? new URL(base).origin + full : b + full;
    }
    const m = __URL_RE.exec(full);
    if (!m) throw new TypeError("Invalid URL: " + input);
    this.protocol = m[1];
    this.username = "";
    this.password = "";
    this.host = m[3] + (m[4] ? ":" + m[4] : "");
    this.hostname = m[3];
    this.port = m[4] || "";
    this.pathname = m[5] || "/";
    this.search = m[6] || "";
    this.hash = m[7] || "";
    this.searchParams = new URLSearchParams(this.search);
    this.origin = this.protocol + "//" + this.host;
  }
  toString() {
    const q = this.searchParams.toString();
    return this.origin + this.pathname + (q ? "?" + q : "") + this.hash;
  }
  get href() { return this.toString(); }
}
globalThis.URL = URL;

// ---- AbortController / AbortSignal (real but "cosmetic" — see module docstring) ----

class AbortSignal {
  constructor() { this.aborted = false; this._listeners = []; }
  addEventListener(type, cb) { if (type === "abort") this._listeners.push(cb); }
  removeEventListener(type, cb) { this._listeners = this._listeners.filter((l) => l !== cb); }
  throwIfAborted() { if (this.aborted) throw new Error("AbortError: signal is aborted"); }
}
class AbortController {
  constructor() { this.signal = new AbortSignal(); }
  abort() {
    if (this.signal.aborted) return;
    this.signal.aborted = true;
    this.signal._listeners.forEach((cb) => { try { cb(); } catch (_e) { /* ignore listener errors */ } });
  }
}
globalThis.AbortController = AbortController;
globalThis.AbortSignal = AbortSignal;

// ---- Blob / FormData (pure; see module docstring re: fetch body encoding) ----

class Blob {
  constructor(parts, options) {
    this._text = (parts || []).map((p) => (typeof p === "string" ? p : __utf8Decode(p))).join("");
    this.type = (options && options.type) || "";
    this.size = __utf8Encode(this._text).length;
  }
  async text() { return this._text; }
  async arrayBuffer() { return __utf8Encode(this._text).buffer; }
}
globalThis.Blob = Blob;

class FormData {
  constructor() { this._entries = []; }
  append(k, v) { this._entries.push([String(k), v]); }
  set(k, v) { this._entries = this._entries.filter(([key]) => key !== String(k)); this._entries.push([String(k), v]); }
  get(k) { const e = this._entries.find(([key]) => key === String(k)); return e ? e[1] : null; }
  getAll(k) { return this._entries.filter(([key]) => key === String(k)).map(([, v]) => v); }
  has(k) { return this._entries.some(([key]) => key === String(k)); }
  delete(k) { this._entries = this._entries.filter(([key]) => key !== String(k)); }
  entries() { return this._entries[Symbol.iterator](); }
  [Symbol.iterator]() { return this._entries[Symbol.iterator](); }
}
globalThis.FormData = FormData;

// ---- formatDate (pure; minimal token replacement, no ICU) ----

globalThis.formatDate = (date, pattern) => {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n, len) => String(n).padStart(len || 2, "0");
  const tokens = {
    YYYY: d.getUTCFullYear(),
    MM: pad(d.getUTCMonth() + 1),
    DD: pad(d.getUTCDate()),
    HH: pad(d.getUTCHours()),
    mm: pad(d.getUTCMinutes()),
    ss: pad(d.getUTCSeconds()),
  };
  return String(pattern || "YYYY-MM-DD").replace(/YYYY|MM|DD|HH|mm|ss/g, (t) => tokens[t]);
};

// ---- console (bridged; fire-and-forget) ----

function __safeArgs(args) {
  try {
    return JSON.parse(JSON.stringify(args));
  } catch (_e) {
    return args.map((a) => String(a));
  }
}
globalThis.console = {
  log: (...args) => { __bridge_console(JSON.stringify(["log", __safeArgs(args)])); },
  info: (...args) => { __bridge_console(JSON.stringify(["log", __safeArgs(args)])); },
  debug: (...args) => { __bridge_console(JSON.stringify(["log", __safeArgs(args)])); },
  warn: (...args) => { __bridge_console(JSON.stringify(["warn", __safeArgs(args)])); },
  error: (...args) => { __bridge_console(JSON.stringify(["error", __safeArgs(args)])); },
};

// ---- setTimeout / clearTimeout (callback never crosses the bridge — only
// a delay does; the callback is invoked entirely inside the sandbox once
// the awaited host sleep promise resolves) ----

let __timeoutCounter = 0;
const __cancelledTimeouts = new Set();
globalThis.setTimeout = (fn, ms, ...args) => {
  const id = ++__timeoutCounter;
  (async () => {
    await __bridge_sleep(JSON.stringify([ms || 0]));
    if (__cancelledTimeouts.has(id)) { __cancelledTimeouts.delete(id); return; }
    try { fn(...args); } catch (e) { console.error("setTimeout callback error:", e && e.message); }
  })();
  return id;
};
globalThis.clearTimeout = (id) => { __cancelledTimeouts.add(id); };
globalThis.clearInterval = globalThis.clearTimeout;

// ---- crypto (bridged; ASYNC — see module docstring) ----

globalThis.crypto = {
  randomUUID: async () => JSON.parse(await __bridge_randomUUID("[]")),
  getRandomValues: async (typedArray) => {
    const bytes = JSON.parse(await __bridge_randomBytes(JSON.stringify([typedArray.length])));
    typedArray.set(bytes);
    return typedArray;
  },
};

// ---- fetch (bridged) ----

globalThis.fetch = async (url, init) => {
  if (init && init.signal && init.signal.aborted) {
    throw new Error("AbortError: fetch aborted before starting");
  }
  let body = init && init.body;
  if (body !== undefined && typeof body !== "string") {
    if (body instanceof Blob) body = await body.text();
    else body = JSON.stringify(body);
  }
  const raw = await __bridge_fetch(
    JSON.stringify([String(url), { method: (init && init.method) || "GET", headers: (init && init.headers) || {}, body }]),
  );
  const data = JSON.parse(raw);
  const headersLower = {};
  for (const k of Object.keys(data.headers || {})) headersLower[k.toLowerCase()] = data.headers[k];
  return {
    ok: data.ok,
    status: data.status,
    statusText: data.statusText,
    url: data.url,
    headers: { get: (name) => headersLower[String(name).toLowerCase()] ?? null },
    json: async () => JSON.parse(__utf8Decode(__base64ToBytes(data.bodyBase64))),
    text: async () => __utf8Decode(__base64ToBytes(data.bodyBase64)),
    arrayBuffer: async () => __base64ToBytes(data.bodyBase64).buffer,
  };
};

// ---- datastore (bridged; scoped per agent by the host, not the sandbox) ----

globalThis.datastore = {
  get: async (key) => JSON.parse(await __bridge_datastoreGet(JSON.stringify([key]))),
  set: async (key, value) => { await __bridge_datastoreSet(JSON.stringify([key, value])); },
  delete: async (key) => { await __bridge_datastoreDelete(JSON.stringify([key])); },
  list: async (prefix) => JSON.parse(await __bridge_datastoreList(JSON.stringify([prefix === undefined ? null : prefix]))),
};

// ---- secrets (bridged; decrypt-on-demand, scoped per agent by the host) ----

globalThis.secrets = {
  get: async (name) => {
    const raw = JSON.parse(await __bridge_secretsGet(JSON.stringify([name])));
    return raw === null ? undefined : raw;
  },
};

// ---- parsers (bridged; real parser libraries run host-side) ----

globalThis.parseHTML = async (html) => JSON.parse(await __bridge_parseHTML(JSON.stringify([String(html)])));
globalThis.parseCSV = async (csv, options) => JSON.parse(await __bridge_parseCSV(JSON.stringify([String(csv), options || null])));
globalThis.parseXML = async (xml, options) => JSON.parse(await __bridge_parseXML(JSON.stringify([String(xml), options || null])));
`;
