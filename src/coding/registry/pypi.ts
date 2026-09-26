/**
 * PyPI registry adapter: parses PyPI allowlist syntax (PEP 503 names, PEP
 * 440 specifiers), routes proxy requests against the PEP 691 JSON Simple
 * API plus PEP 658 metadata files, restricts downloads to wheels, and
 * configures pip for the sandboxed worker to use the proxy as its only
 * index with binary-only installs.
 */
import { clean as pepClean, compare as pepCompare, satisfies as pepSatisfies, validRange } from "@renovatebot/pep440";
import { unzipSync, strFromU8 } from "fflate";
import {
  AllowlistEntryError,
  RegistryError,
  type FileRef,
  type PackageMetadata,
  type RegistryAdapter,
  type RegistryRoute,
  type VersionInfo,
} from "./types.js";

const UPSTREAM = "https://pypi.org/simple/";
const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";
const ENTRY = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(.*)$/;
const WHEEL_METADATA_LIMIT = 64 * 1024 * 1024;

interface SimpleFile {
  filename: string;
  url: string;
  hashes?: { sha256?: string };
  "upload-time"?: string;
  size?: number;
  "core-metadata"?: boolean | { sha256?: string };
  "dist-info-metadata"?: boolean | { sha256?: string };
  "requires-python"?: string;
  yanked?: boolean | string;
}
interface SimpleIndex {
  name: string;
  files: SimpleFile[];
}

export function normalizePypiName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** Version from a wheel ("name-1.0-py3-none-any.whl") or sdist ("name-1.0.tar.gz") filename. */
function versionOf(filename: string): string | null {
  if (filename.endsWith(".whl")) return filename.split("-")[1] ?? null;
  const sdist = filename.match(/^.+?-(\d[^-]*)\.(?:tar\.gz|zip)$/);
  return sdist ? sdist[1] : null;
}

export function requiresDist(metadataText: string): string[] {
  const names = new Set<string>();
  for (const line of metadataText.split(/\r?\n/)) {
    if (!line.startsWith("Requires-Dist:")) continue;
    const value = line.slice("Requires-Dist:".length).trim();
    if (/;\s*.*\bextra\s*==/.test(value)) continue;
    const name = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (name) names.add(normalizePypiName(name[1]));
  }
  return [...names];
}

export const pypiAdapter: RegistryAdapter = {
  id: "pypi",
  osvEcosystem: "PyPI",
  upstreamHosts: ["pypi.org", "files.pythonhosted.org"],
  collectExclude: [".venv", "venv", "__pycache__"],

  parseAllowlistEntry(raw) {
    const match = raw.trim().match(ENTRY);
    if (!match) throw new AllowlistEntryError(`"${raw}" is not a valid Python package entry`);
    const name = normalizePypiName(match[1]);
    const range = match[2].trim();
    if (!range) return { name, wildcard: false };
    if (!validRange(range)) throw new AllowlistEntryError(`"${range}" is not a valid PEP 440 specifier`);
    return { name, wildcard: false, range };
  },

  normalizeName: normalizePypiName,

  satisfies: (version, range) => pepSatisfies(version, range),

  compareVersions(a, b) {
    // OSV and PyPI filenames both carry non-canonical spellings ("2.0rc1",
    // "1.0-post1"); normalize each to PEP 440 before comparing.
    const left = pepClean(a);
    const right = pepClean(b);
    if (!left || !right) throw new Error(`not a PEP 440 version: "${a}" / "${b}"`);
    return pepCompare(left, right);
  },

  route(method, subpath): RegistryRoute | null {
    if (method !== "GET" && method !== "HEAD") return null;
    const simple = subpath.match(/^simple\/([^/]+)\/?$/);
    if (simple) return { kind: "metadata", name: normalizePypiName(decodeURIComponent(simple[1])) };
    const file = subpath.match(/^files\/([^/]+)\/([^/]+)$/);
    if (!file) return null;
    const name = normalizePypiName(decodeURIComponent(file[1]));
    const filename = decodeURIComponent(file[2]);
    if (filename.endsWith(".metadata")) {
      return { kind: "file-metadata", name, filename: filename.slice(0, -".metadata".length) };
    }
    const version = versionOf(filename);
    return version ? { kind: "download", name, version, filename } : null;
  },

  async fetchMetadata(name, upstream): Promise<PackageMetadata> {
    const response = await upstream(`${UPSTREAM}${name}/`, { accept: SIMPLE_JSON });
    if (response.status === 404)
      throw new RegistryError(404, "wardby_package_not_found", `PyPI has no package "${name}"`);
    if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `PyPI returned ${response.status}`);
    const index = (await response.json()) as SimpleIndex;
    const grouped = new Map<string, { files: FileRef[]; times: number[] }>();
    for (const file of index.files) {
      const version = versionOf(file.filename);
      if (!version || file.yanked) continue;
      const entry = grouped.get(version) ?? { files: [], times: [] };
      entry.files.push({
        filename: file.filename,
        version,
        upstreamUrl: file.url,
        integrity: file.hashes?.sha256 ? { algorithm: "sha256", hex: file.hashes.sha256 } : null,
        sizeBytes: file.size ?? null,
        allowed: file.filename.endsWith(".whl"),
      });
      if (file["upload-time"]) entry.times.push(Date.parse(file["upload-time"]));
      grouped.set(version, entry);
    }
    const versions = new Map<string, VersionInfo>();
    for (const [version, { files, times }] of grouped) {
      versions.set(version, {
        version,
        publishedAt: times.length === files.length ? new Date(Math.min(...times)) : null,
        dependencies: [],
        files,
      });
    }
    return { name: normalizePypiName(index.name), versions, raw: index };
  },

  renderMetadata(meta, keep, proxyBase) {
    const index = meta.raw as SimpleIndex;
    const files = index.files
      .filter((file) => file.filename.endsWith(".whl"))
      .filter((file) => keep.has(versionOf(file.filename) ?? ""))
      .map((file) => ({
        ...file,
        url: `${proxyBase}files/${encodeURIComponent(meta.name)}/${encodeURIComponent(file.filename)}`,
      }));
    return {
      contentType: SIMPLE_JSON,
      body: JSON.stringify({ meta: { "api-version": "1.1" }, name: meta.name, files, versions: [...keep] }),
    };
  },

  resolveDownload(route, meta) {
    return meta.versions.get(route.version)?.files.find((file) => file.filename === route.filename) ?? null;
  },

  resolveFileMetadata(route, meta) {
    const index = meta.raw as SimpleIndex;
    const source = index.files.find((file) => file.filename === route.filename);
    const version = versionOf(route.filename);
    const declared = source?.["core-metadata"] ?? source?.["dist-info-metadata"];
    if (!source || !version || !declared || !source.filename.endsWith(".whl")) return null;
    const sha256 = typeof declared === "object" ? declared.sha256 : undefined;
    return {
      filename: `${route.filename}.metadata`,
      version,
      upstreamUrl: `${source.url}.metadata`,
      integrity: sha256 ? { algorithm: "sha256", hex: sha256 } : null,
      sizeBytes: null,
      allowed: true,
    };
  },

  async dependenciesFromFile(route, body) {
    if (route.kind === "file-metadata") return requiresDist(new TextDecoder().decode(body));
    if (!route.filename.endsWith(".whl") || body.byteLength > WHEEL_METADATA_LIMIT) return [];
    const entries = unzipSync(body, { filter: (file) => /\.dist-info\/METADATA$/.test(file.name) });
    const metadata = Object.values(entries)[0];
    return metadata ? requiresDist(strFromU8(metadata)) : [];
  },

  workerConfig({ registryUrl, token, cacheDir }) {
    const index = new URL("simple/", registryUrl);
    index.username = "wardby";
    index.password = token;
    return {
      env: {
        PIP_INDEX_URL: index.toString(),
        PIP_TRUSTED_HOST: index.hostname,
        PIP_ONLY_BINARY: ":all:",
        PIP_CACHE_DIR: cacheDir,
        PIP_DISABLE_PIP_VERSION_CHECK: "1",
        PIP_NO_INPUT: "1",
      },
      files: [],
    };
  },
};
