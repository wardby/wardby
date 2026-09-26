/**
 * npm lockfile normaliser. The npm adapter serves metadata whose tarball
 * links point at the proxy, so `npm install` in the worker records those
 * proxy URLs as `resolved` in package-lock.json / npm-shrinkwrap.json. They
 * only resolve inside the sandbox, so before the workspace is collected every
 * `resolved` value under the proxy's npm route is rewritten to the canonical
 * public registry URL for the same package and version. `integrity` is left
 * as is: it covers the same tarball bytes. Only the matched values change;
 * the rest of the file stays byte-for-byte identical (no JSON round trip).
 *
 * Kept free of imports from npm.ts, which imports this module.
 */
import semver from "semver";

const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
/** Same shape as the adapter's allowlist name check (scoped names are lower case). */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[A-Za-z0-9-~][A-Za-z0-9-._~]*)$/;
/** A `"resolved": "<value>"` pair whose value has no JSON escapes. */
const RESOLVED = /("resolved"\s*:\s*")([^"\\]*)(")/g;

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function unscoped(name: string): string {
  return name.slice(name.indexOf("/") + 1);
}

/** The package and version a path under the proxy's npm base downloads:
 *  `-/tarball/<encoded name>/<version>` (the proxy's own route) or the
 *  standard `<name>/-/<unscoped>-<version>.tgz`, with the scope separator
 *  literal or percent-encoded. Null for anything else. */
function parseProxyPath(path: string): { name: string; version: string } | null {
  let name: string | null;
  let version: string | null;
  const own = path.match(/^-\/tarball\/([^/]+)\/([^/]+)$/);
  if (own) {
    name = decode(own[1]);
    version = decode(own[2]);
  } else {
    const standard = path.match(/^(.+)\/-\/([^/]+)\.tgz$/);
    if (!standard) return null;
    name = decode(standard[1]);
    const file = decode(standard[2]);
    if (!name || !file) return null;
    const prefix = `${unscoped(name)}-`;
    version = file.startsWith(prefix) ? file.slice(prefix.length) : null;
  }
  if (!name || !version || !PACKAGE_NAME.test(name) || semver.valid(version) !== version) return null;
  return { name, version };
}

/** `https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz` */
export function publicNpmTarballUrl(name: string, version: string): string {
  return `${PUBLIC_REGISTRY}${name}/-/${unscoped(name)}-${version}.tgz`;
}

export function normalizeNpmLockfile(content: string, registryUrl: string): string {
  const base = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return content.replace(RESOLVED, (match, open: string, url: string, close: string) => {
    if (!url.startsWith(base)) return match;
    const target = parseProxyPath(url.slice(base.length));
    return target ? `${open}${publicNpmTarballUrl(target.name, target.version)}${close}` : match;
  });
}

export const npmLockfiles = {
  names: ["package-lock.json", "npm-shrinkwrap.json"],
  normalize: normalizeNpmLockfile,
} as const;
