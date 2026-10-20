/**
 * PyPI registry adapter: parses PyPI allowlist syntax (PEP 503 names, PEP
 * 440 specifiers), routes proxy requests against the PEP 691 JSON Simple
 * API plus PEP 658 metadata files, restricts downloads to wheels, and
 * configures pip and uv for the sandboxed worker to use the proxy as their
 * only index with binary-only installs.
 */
import { clean as pepClean, compare as pepCompare, satisfies as pepSatisfies, validRange } from "@renovatebot/pep440";
import { unzipSync, strFromU8 } from "fflate";
import { normalizeUvLock, pypiLockfilePlan } from "./pypi-plan.js";
import {
  isPypiProjectName,
  MAX_EXTRAS,
  normalizePypiName,
  parseExtras,
  requiredDists,
  requiresDist,
} from "./pypi-requirements.js";
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
/** name, an optional `[extras]` group (checked separately), then the specifier. */
const ENTRY = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?\s*(.*)$/;
const WHEEL_METADATA_LIMIT = 64 * 1024 * 1024;

export { isPypiProjectName, MAX_EXTRAS, normalizePypiName, parseExtras, requiredDists, requiresDist };

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

function uploadTime(file: SimpleFile): Date | null {
  const time = file["upload-time"] ? Date.parse(file["upload-time"]) : NaN;
  return Number.isNaN(time) ? null : new Date(time);
}

function decoded(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RegistryError(400, "wardby_bad_request", "malformed percent-encoding in the registry path");
  }
}

function projectName(segment: string): string {
  const name = decoded(segment);
  if (!isPypiProjectName(name)) throw new RegistryError(400, "wardby_bad_request", "not a valid Python project name");
  return normalizePypiName(name);
}

function isSdist(filename: string): boolean {
  return /\.(?:tar\.gz|zip)$/.test(filename);
}

/** Version from a wheel ("name-1.0-py3-none-any.whl") or sdist ("name-1.0.tar.gz") filename. */
function versionOf(filename: string): string | null {
  if (filename.endsWith(".whl")) return filename.split("-")[1] ?? null;
  const sdist = filename.match(/^.+?-(\d[^-]*)\.(?:tar\.gz|zip)$/);
  return sdist ? sdist[1] : null;
}

export const pypiAdapter: RegistryAdapter = {
  id: "pypi",
  osvEcosystem: "PyPI",
  upstreamHosts: ["pypi.org", "files.pythonhosted.org"],
  collectExclude: [".venv", "venv", "__pycache__"],
  dependenciesInMetadata: false,
  // uv records the proxy's URLs in a uv.lock it writes through it.
  lockfiles: { names: ["uv.lock"], normalize: (content, registryUrl) => normalizeUvLock(content, registryUrl) },
  lockfilePlan: pypiLockfilePlan,

  parseAllowlistEntry(raw) {
    const match = raw.trim().match(ENTRY);
    if (!match) throw new AllowlistEntryError(`"${raw}" is not a valid Python package entry`);
    const name = normalizePypiName(match[1]);
    let extras: string[] | undefined;
    if (match[2] !== undefined) {
      const parsed = parseExtras(match[2]);
      if (!parsed)
        throw new AllowlistEntryError(
          `"[${match[2]}]" in "${raw}" is not a valid list of extras (comma-separated names, at most ${MAX_EXTRAS})`,
        );
      extras = parsed;
    }
    const range = match[3].trim();
    if (range && !validRange(range)) throw new AllowlistEntryError(`"${range}" is not a valid PEP 440 specifier`);
    return { name, wildcard: false, ...(extras ? { extras } : {}), ...(range ? { range } : {}) };
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
    if (simple) return { kind: "metadata", name: projectName(simple[1]) };
    const file = subpath.match(/^files\/([^/]+)\/([^/]+)$/);
    if (!file) return null;
    const name = projectName(file[1]);
    const filename = decoded(file[2]);
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
    const versions = new Map<string, VersionInfo & { files: FileRef[] }>();
    for (const file of index.files) {
      const version = versionOf(file.filename);
      if (!version || file.yanked) continue;
      const entry = versions.get(version) ?? { version, dependencies: [], files: [] };
      entry.files.push({
        filename: file.filename,
        version,
        upstreamUrl: file.url,
        integrity: file.hashes?.sha256 ? { algorithm: "sha256", hex: file.hashes.sha256 } : null,
        sizeBytes: file.size ?? null,
        allowed: file.filename.endsWith(".whl"),
        publishedAt: uploadTime(file),
      });
      versions.set(version, entry);
    }
    // Keep only what renderMetadata and resolveFileMetadata read: wheels and
    // sdists, with the PEP 691 file fields pip and uv use. An sdist is listed
    // (so a uv.lock written through the proxy keeps it, as one written
    // against PyPI does) but never served: downloads are wheels only, and
    // PIP_ONLY_BINARY / UV_NO_BUILD keep both clients off it. Its metadata
    // file is never offered.
    const raw: SimpleIndex = {
      name: index.name,
      files: index.files
        .filter((file) => (file.filename.endsWith(".whl") || isSdist(file.filename)) && !file.yanked)
        .map((file) => {
          const wheel = file.filename.endsWith(".whl");
          return {
            filename: file.filename,
            url: file.url,
            ...(file.hashes ? { hashes: file.hashes } : {}),
            ...(file["upload-time"] ? { "upload-time": file["upload-time"] } : {}),
            ...(file.size !== undefined ? { size: file.size } : {}),
            ...(wheel && file["core-metadata"] !== undefined ? { "core-metadata": file["core-metadata"] } : {}),
            ...(wheel && file["dist-info-metadata"] !== undefined
              ? { "dist-info-metadata": file["dist-info-metadata"] }
              : {}),
            ...(file["requires-python"] !== undefined ? { "requires-python": file["requires-python"] } : {}),
          };
        }),
    };
    return { name: normalizePypiName(index.name), versions, raw };
  },

  renderMetadata(meta, keep, keptFiles, proxyBase) {
    const index = meta.raw as SimpleIndex;
    const files = index.files
      .filter((file) => keep.has(versionOf(file.filename) ?? "") && keptFiles.has(file.filename))
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
      // The metadata file is as old as the wheel it describes.
      publishedAt: uploadTime(source),
    };
  },

  async dependenciesFromFile(route, body, extras) {
    if (route.kind === "file-metadata") return requiredDists(new TextDecoder().decode(body), extras);
    if (!route.filename.endsWith(".whl") || body.byteLength > WHEEL_METADATA_LIMIT) return [];
    const entries = unzipSync(body, { filter: (file) => /\.dist-info\/METADATA$/.test(file.name) });
    const metadata = Object.values(entries)[0];
    return metadata ? requiredDists(strFromU8(metadata), extras) : [];
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
        // uv reads none of pip's settings: without these it goes straight to pypi.org,
        // which the sandbox can't reach. UV_NO_BUILD refuses sdists from the index (the
        // wheels-only rule) and still builds the project itself.
        UV_DEFAULT_INDEX: index.toString(),
        UV_NO_BUILD: "1",
        UV_CACHE_DIR: `${cacheDir}/uv`,
        UV_PYTHON_DOWNLOADS: "never",
      },
      files: [],
    };
  },
};
