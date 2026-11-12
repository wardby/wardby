import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerResponse } from "node:http";

/**
 * Browser assets for the document pages. The build writes them, with hashed
 * names, to `dist/web-assets/` together with `manifest.json`: an object from
 * logical names to hashed file names, e.g.
 * `{ "documents.js": "documents-3f9a1c.js", "documents.css": "documents-3f9a1c.css" }`.
 * Only the files the manifest names are ever served (an allow-list), so no
 * request path reaches the filesystem; the manifest is read per request.
 */
export const STATIC_PREFIX = "/web/static/";

/** dist/web-assets, next to dist/web where this module is compiled to. */
export const DEFAULT_ASSETS_ROOT = fileURLToPath(new URL("../web-assets/", import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$/;

function extension(name: string): string {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i);
}

export type AssetManifest = Record<string, string>;

/** The parsed manifest, or null when it is missing or not a map of safe file names. */
export async function readManifest(root: string): Promise<AssetManifest | null> {
  let raw: string;
  try {
    raw = await readFile(join(root, "manifest.json"), "utf8");
  } catch {
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const out: AssetManifest = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== "string" || !FILE_NAME.test(v) || !(extension(v) in CONTENT_TYPES)) return null;
      out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Serves `/web/static/<name>` when the manifest names `<name>`; otherwise
 * answers 404. The name is matched as an exact string against the manifest's
 * values, so dot segments, encoded slashes and unlisted files never resolve.
 */
export async function serveStatic(res: ServerResponse, pathname: string, root: string): Promise<void> {
  const name = pathname.slice(STATIC_PREFIX.length);
  const manifest = name ? await readManifest(root) : null;
  const listed = manifest !== null && Object.values(manifest).includes(name);
  let body: Buffer | undefined;
  if (listed) {
    try {
      body = await readFile(join(root, name));
    } catch {
      body = undefined;
    }
  }
  if (!body) {
    res
      .writeHead(404, {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      })
      .end(JSON.stringify({ error: "not_found" }));
    return;
  }
  res
    .writeHead(200, {
      "content-type": CONTENT_TYPES[extension(name)],
      "content-length": String(body.length),
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    })
    .end(body);
}
