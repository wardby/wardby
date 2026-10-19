/**
 * PyPI registry adapter: parses PyPI allowlist syntax (PEP 503 names, PEP
 * 440 specifiers), routes proxy requests against the PEP 691 JSON Simple
 * API plus PEP 658 metadata files, restricts downloads to wheels, and
 * configures pip and uv for the sandboxed worker to use the proxy as their
 * only index with binary-only installs.
 */
import { clean as pepClean, compare as pepCompare, satisfies as pepSatisfies, validRange } from "@renovatebot/pep440";
import { unzipSync, strFromU8 } from "fflate";
import {
  AllowlistEntryError,
  RegistryError,
  type FileDependency,
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
/** The most extras one allowlist entry or dependency line may name. */
export const MAX_EXTRAS = 32;
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

function uploadTime(file: SimpleFile): Date | null {
  const time = file["upload-time"] ? Date.parse(file["upload-time"]) : NaN;
  return Number.isNaN(time) ? null : new Date(time);
}

/** A valid PyPI project name (PEP 508): ASCII letters and digits, with
 *  `.`, `_` and `-` allowed only between them. */
const PROJECT_NAME = /^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/;

export function isPypiProjectName(name: string): boolean {
  return PROJECT_NAME.test(name);
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
  if (!PROJECT_NAME.test(name)) throw new RegistryError(400, "wardby_bad_request", "not a valid Python project name");
  return normalizePypiName(name);
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

/** Normalized (PEP 685), sorted, de-duplicated extras from the text inside
 *  `[...]`, or null when any is not a valid extra name (PEP 508: the same
 *  shape as a project name), the list is empty, or it names too many. */
export function parseExtras(list: string): string[] | null {
  const items = list.split(",").map((item) => item.trim());
  if (items.length > MAX_EXTRAS || items.some((item) => !PROJECT_NAME.test(item))) return null;
  return [...new Set(items.map(normalizePypiName))].sort();
}

/** The string literals a marker compares `extra` to with `==` or `===`
 *  (either operand order), normalized; null when the marker never mentions
 *  `extra`. Tokenized, so a quoted value never counts as a clause. Fails
 *  closed: when `extra` appears in any shape this does not fully recognise
 *  (`extra in "a b"`, `extra.x`, a bare `extra`, an unbalanced quote), the
 *  line is gated on no extra at all, so it is never followed. */
function markerExtras(marker: string): string[] | null {
  if (!/\bextra\b/.test(marker)) return null;
  const tokens = marker.match(/"[^"]*"|'[^']*'|===|==|!=|<=|>=|~=|[A-Za-z_][A-Za-z0-9_.]*|\S/g) ?? [];
  const isLiteral = (token: string | undefined) =>
    token !== undefined && token.length >= 2 && (token[0] === '"' || token[0] === "'");
  const isEquals = (token: string | undefined) => token === "==" || token === "===";
  // A lone quote (unterminated string) means the marker cannot be read.
  if (tokens.some((token) => token === '"' || token === "'")) return [];
  const found: string[] = [];
  let recognised = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== "extra") continue;
    let value: string | null = null;
    if (isEquals(tokens[i + 1]) && isLiteral(tokens[i + 2])) value = tokens[i + 2].slice(1, -1);
    else if (isEquals(tokens[i - 1]) && isLiteral(tokens[i - 2])) value = tokens[i - 2].slice(1, -1);
    if (value === null) return [];
    recognised++;
    if (PROJECT_NAME.test(value)) found.push(normalizePypiName(value));
  }
  // `extra` only inside quoted values: not a clause, but not one this reads either.
  return recognised === 0 ? [] : found;
}

interface RequirementLine {
  name: string;
  extras: string[];
  /** The extras the line is gated on; null when it is not extra-gated. */
  gate: string[] | null;
}

const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[([^\]]*)\])?/;

// Splits each Requires-Dist value only at its first `;` (the marker), which is
// all wheel METADATA needs: no `name @ url` with a `;` in the URL, no comments
// or line continuations as in a requirements file.
function requirementLines(metadataText: string): { self: string | null; lines: RequirementLine[] } {
  let self: string | null = null;
  const lines: RequirementLine[] = [];
  for (const line of metadataText.split(/\r?\n/)) {
    // The headers end at the first truly empty line; the description
    // follows. A whitespace-only line is a folded header's continuation.
    if (line === "") break;
    if (line.startsWith("Name:")) {
      const name = line.slice("Name:".length).trim();
      if (self === null && PROJECT_NAME.test(name)) self = normalizePypiName(name);
      continue;
    }
    if (!line.startsWith("Requires-Dist:")) continue;
    const value = line.slice("Requires-Dist:".length).trim();
    const match = value.match(REQUIREMENT);
    if (!match || !PROJECT_NAME.test(match[1])) continue;
    const semicolon = value.indexOf(";", match[0].length);
    lines.push({
      name: normalizePypiName(match[1]),
      // A malformed extras list still installs the package, just none of its extras.
      extras: match[2] === undefined ? [] : (parseExtras(match[2]) ?? []),
      gate: semicolon === -1 ? null : markerExtras(value.slice(semicolon + 1)),
    });
  }
  return { self, lines };
}

/**
 * The dependencies a wheel's METADATA declares for an install of the package
 * with `extras`: every line without an `extra == "…"` marker clause, plus the
 * lines whose marker names one of `extras` (other marker clauses are ignored,
 * so a requested extra's lines are included on every platform). A line gated
 * on any other extra is skipped. Each dependency carries the extras its line
 * asks of it (`uvicorn[standard]`); a line naming the package itself
 * (`celery[redis]; extra == "all"`) adds those extras to this install
 * instead. Names and extras are validated and normalized.
 *
 * Policy, not pip: a plain install (no `extras`) follows no extras at all,
 * neither its own (a self-referencing line) nor its dependencies' — each
 * dependency comes back bare, so extras are followed only along a chain that
 * starts at an allowlist entry naming extras.
 */
export function requiredDists(metadataText: string, extras: readonly string[] = []): FileDependency[] {
  const { self, lines } = requirementLines(metadataText);
  const requested = new Set(extras.map(normalizePypiName));
  const plain = requested.size === 0;
  const included = (line: RequirementLine) => line.gate === null || line.gate.some((extra) => requested.has(extra));
  for (let grew = !plain; grew;) {
    grew = false;
    for (const line of lines) {
      if (line.name !== self || !included(line)) continue;
      for (const extra of line.extras) {
        if (requested.size >= MAX_EXTRAS || requested.has(extra)) continue;
        requested.add(extra);
        grew = true;
      }
    }
  }
  const out = new Map<string, Set<string>>();
  for (const line of lines) {
    if (line.name === self || !included(line)) continue;
    const merged = out.get(line.name) ?? new Set<string>();
    if (!plain) for (const extra of line.extras) if (merged.size < MAX_EXTRAS) merged.add(extra);
    out.set(line.name, merged);
  }
  return [...out].map(([name, merged]) => ({ name, extras: [...merged].sort() }));
}

/** Dependency names a METADATA declares for a plain install (no extras). */
export function requiresDist(metadataText: string): string[] {
  return requiredDists(metadataText).map((dependency) => dependency.name);
}

export const pypiAdapter: RegistryAdapter = {
  id: "pypi",
  osvEcosystem: "PyPI",
  upstreamHosts: ["pypi.org", "files.pythonhosted.org"],
  collectExclude: [".venv", "venv", "__pycache__"],
  dependenciesInMetadata: false,

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
    // Keep only what renderMetadata and resolveFileMetadata read: wheels,
    // with the PEP 691 file fields pip uses.
    const raw: SimpleIndex = {
      name: index.name,
      files: index.files
        .filter((file) => file.filename.endsWith(".whl") && !file.yanked)
        .map((file) => ({
          filename: file.filename,
          url: file.url,
          ...(file.hashes ? { hashes: file.hashes } : {}),
          ...(file["upload-time"] ? { "upload-time": file["upload-time"] } : {}),
          ...(file.size !== undefined ? { size: file.size } : {}),
          ...(file["core-metadata"] !== undefined ? { "core-metadata": file["core-metadata"] } : {}),
          ...(file["dist-info-metadata"] !== undefined ? { "dist-info-metadata": file["dist-info-metadata"] } : {}),
          ...(file["requires-python"] !== undefined ? { "requires-python": file["requires-python"] } : {}),
        })),
    };
    return { name: normalizePypiName(index.name), versions, raw };
  },

  renderMetadata(meta, keep, keptFiles, proxyBase) {
    const index = meta.raw as SimpleIndex;
    const files = index.files
      .filter((file) => file.filename.endsWith(".whl"))
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
