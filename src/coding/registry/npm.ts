/**
 * npm registry adapter: parses npm allowlist syntax and semver ranges,
 * routes proxy requests against the npm HTTP protocol (packuments,
 * `-/tarball/<name>/<version>` downloads, and the standard
 * `<name>/-/<unscoped>-<version>.tgz` path lockfiles record), and configures npm/npmrc for
 * the sandboxed worker to use the proxy with install-time scripts disabled.
 */
import semver from "semver";
import { npmLockfiles } from "./npm-lockfile.js";
import { npmLockfilePlan, registryDependencyEdges } from "./npm-plan.js";
import {
  AllowlistEntryError,
  RegistryError,
  type AllowlistEntry,
  type DependencySpec,
  type DownloadRoute,
  type FileRef,
  type Integrity,
  type PackageMetadata,
  type RegistryAdapter,
  type RegistryRoute,
  type VersionInfo,
} from "./types.js";

/** Scoped names are lower case (npm never allowed capitals in them); an
 *  unscoped legacy name may contain capitals, and npm treats it as a
 *  different package from its lower-case spelling (`JSONStream` is not
 *  `jsonstream`), so names are never case-folded anywhere. */
const NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/[a-z0-9-~][a-z0-9-._~]*|[A-Za-z0-9-~][A-Za-z0-9-._~]*)$/;
const SCOPE_WILDCARD = /^(@[a-z0-9-~][a-z0-9-._~]*)\/\*$/;
const UPSTREAM = "https://registry.npmjs.org/";

interface Packument {
  name: string;
  "dist-tags"?: Record<string, string>;
  time?: Record<string, string>;
  versions: Record<
    string,
    {
      dist: { tarball: string; integrity?: string; shasum?: string };
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    }
  >;
}

/** The per-version fields npm's installer reads (the same set as npm's
 *  abbreviated "install-v1" manifest). Only these are kept from an
 *  upstream packument, so the cached metadata never holds readmes,
 *  descriptions, maintainers and other bulk the proxy does not render. */
const MANIFEST_FIELDS = [
  "name",
  "version",
  "dist",
  "dependencies",
  "optionalDependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "bundleDependencies",
  "bundledDependencies",
  "acceptDependencies",
  "bin",
  "directories",
  "engines",
  "os",
  "cpu",
  "libc",
  "deprecated",
  "hasInstallScript",
  "_hasShrinkwrap",
  "license",
  "funding",
] as const;

function abbreviated(manifest: Packument["versions"][string]): Packument["versions"][string] {
  const source = manifest as unknown as Record<string, unknown>;
  const kept = Object.fromEntries(MANIFEST_FIELDS.filter((field) => field in source).map((f) => [f, source[f]]));
  return kept as unknown as Packument["versions"][string];
}

function integrityOf(dist: { integrity?: string; shasum?: string }): Integrity | null {
  const sri = dist.integrity?.match(/^(sha512|sha384|sha256)-([A-Za-z0-9+/=]+)$/);
  if (sri) return { algorithm: sri[1] as Integrity["algorithm"], hex: Buffer.from(sri[2], "base64").toString("hex") };
  if (dist.shasum && /^[a-f0-9]{40}$/.test(dist.shasum)) return { algorithm: "sha1", hex: dist.shasum };
  return null;
}

/** The registry package each dependency entry installs, and the range it
 *  asks for (aliases resolved, non-registry specs dropped; see
 *  registryDependencyEdges). This is the single place both the metadata
 *  path and the graph walk get dependency names from. */
export function registryDependencies(deps: Record<string, string> | undefined): DependencySpec[] {
  return registryDependencyEdges(deps).map(({ name, range }) => ({ name, range }));
}

/** Maps `<name>/-/<unscoped>-<version>.tgz` (already percent-decoded) to
 *  the same download route as `-/tarball/<name>/<version>`, or null. The
 *  filename must name this exact package (case-sensitive, as npm names
 *  are) and an exact semver version, so it can never smuggle a path
 *  separator or `..` through: neither can appear in a valid version. */
function standardTarball(name: string, filename: string): DownloadRoute | null {
  if (!NAME.test(name)) return null;
  const unscoped = name.slice(name.indexOf("/") + 1);
  const prefix = `${unscoped}-`;
  if (!filename.startsWith(prefix) || !filename.endsWith(".tgz")) return null;
  const version = filename.slice(prefix.length, -".tgz".length);
  if (semver.valid(version) !== version) return null;
  return { kind: "download", name, version, filename: `${version}.tgz` };
}

function validName(name: string): string {
  if (!NAME.test(name)) throw new AllowlistEntryError(`"${name}" is not a valid npm package name`);
  return name;
}

/** What `renderMetadata` needs, kept only when metadata is fetched to be
 *  served to a client: each version's install manifest as compact JSON (a
 *  string is a fraction of the size of the same data as objects, and only
 *  the kept versions are ever parsed back), its publish time as upstream
 *  wrote it, and the dist-tags. */
interface NpmRenderData {
  name: string;
  distTags: Record<string, string>;
  manifests: Map<string, string>;
  times: Map<string, string>;
}

/** Per-version fixed cost, in bytes, of the trimmed form (Map entry,
 *  VersionInfo, FileRef, Date, arrays), used only for the metadata cache's
 *  byte budget. Deliberately generous. */
const VERSION_OVERHEAD_BYTES = 400;
const DEPENDENCY_OVERHEAD_BYTES = 80;

/** Extracts what the proxy uses from a full packument, copying every value
 *  it keeps, so the document itself is never retained: per version its
 *  dependency specs, publish time, tarball URL and integrity (all the graph
 *  walk, the version filter and downloads read), plus, with `render`, the
 *  data `renderMetadata` serves. */
function trimPackument(name: string, doc: Packument, render: boolean): PackageMetadata {
  const versions = new Map<string, VersionInfo>();
  const renderData: NpmRenderData | undefined = render
    ? { name: String(doc.name), distTags: { ...(doc["dist-tags"] ?? {}) }, manifests: new Map(), times: new Map() }
    : undefined;
  let approxBytes = 256 + name.length;
  for (const [version, info] of Object.entries(doc.versions ?? {})) {
    const published = doc.time?.[version];
    const dependencySpecs = [info.dependencies, info.optionalDependencies, info.peerDependencies].flatMap((deps) =>
      registryDependencies(deps),
    );
    const dependencies = [...new Set(dependencySpecs.map((spec) => spec.name))];
    const file: FileRef = {
      filename: `${version}.tgz`,
      version,
      upstreamUrl: String(info.dist.tarball),
      integrity: integrityOf(info.dist),
      sizeBytes: null,
      allowed: true,
      publishedAt: published ? new Date(published) : null,
    };
    versions.set(version, { version, dependencies, dependencySpecs, files: [file] });
    approxBytes += VERSION_OVERHEAD_BYTES + 2 * version.length + file.upstreamUrl.length;
    approxBytes += file.integrity?.hex.length ?? 0;
    for (const spec of dependencySpecs) approxBytes += DEPENDENCY_OVERHEAD_BYTES + spec.name.length + spec.range.length;
    if (renderData) {
      const manifest = JSON.stringify(abbreviated(info));
      renderData.manifests.set(version, manifest);
      approxBytes += manifest.length + 64;
      if (published) {
        renderData.times.set(version, String(published));
        approxBytes += published.length + 64;
      }
    }
  }
  return { name, versions, raw: renderData, approxBytes };
}

export const npmAdapter: RegistryAdapter = {
  id: "npm",
  osvEcosystem: "npm",
  upstreamHosts: ["registry.npmjs.org"],
  collectExclude: ["node_modules"],
  dependenciesInMetadata: true,
  lockfiles: npmLockfiles,
  lockfilePlan: npmLockfilePlan,

  parseAllowlistEntry(raw: string): AllowlistEntry {
    const value = raw.trim();
    // Scopes are always lower case on npm, so folding one cannot select a
    // different package; package names are kept exactly as written.
    const scope = value.toLowerCase().match(SCOPE_WILDCARD);
    if (scope) return { name: `${scope[1]}/`, wildcard: true };
    const at = value.indexOf("@", 1);
    const name = validName(at > 0 ? value.slice(0, at) : value);
    if (at < 0) return { name, wildcard: false };
    const range = value.slice(at + 1);
    if (!semver.validRange(range)) throw new AllowlistEntryError(`"${range}" is not a valid npm version range`);
    return { name, wildcard: false, range };
  },

  normalizeName: (name) => name,

  satisfies: (version, range) => semver.satisfies(version, range),

  compareVersions(a, b) {
    if (!semver.valid(a) || !semver.valid(b)) throw new Error(`not a semver version: "${a}" / "${b}"`);
    return semver.compare(a, b);
  },

  route(method, subpath): RegistryRoute | null {
    if (method !== "GET" && method !== "HEAD") return null;
    const tarball = subpath.match(/^-\/tarball\/([^/]+)\/([^/]+)$/);
    // The standard upstream tarball path, `<name>/-/<unscoped>-<version>.tgz`,
    // which a lockfile's `resolved` URLs point at once npm rewrites their
    // host to the configured registry (replace-registry-host). The name is
    // one segment (`react`, `@scope%2fpkg`) or a literal scope plus name
    // (`@scope/pkg`); the filename is one raw segment.
    const standard = subpath.match(/^((?:@[^/]+\/)?[^/]+)\/-\/([^/]+)$/);
    try {
      if (tarball) {
        const name = decodeURIComponent(tarball[1]);
        const version = decodeURIComponent(tarball[2]);
        if (!NAME.test(name) || !semver.valid(version)) return null;
        return { kind: "download", name, version, filename: `${version}.tgz` };
      }
      if (standard) return standardTarball(decodeURIComponent(standard[1]), decodeURIComponent(standard[2]));
      const name = decodeURIComponent(subpath);
      return NAME.test(name) ? { kind: "metadata", name } : null;
    } catch {
      throw new RegistryError(400, "wardby_bad_request", "malformed percent-encoding in the registry path");
    }
  },

  async fetchMetadata(name, upstream, options = {}): Promise<PackageMetadata> {
    const response = await upstream(`${UPSTREAM}${name.replaceAll("/", "%2f")}`, { accept: "application/json" });
    if (response.status === 404)
      throw new RegistryError(404, "wardby_package_not_found", `npm has no package "${name}"`);
    if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `npm returned ${response.status}`);
    // The full packument is only ever a local of `trimPackument`: nothing
    // returned from here references it, so it is garbage as soon as the
    // trimmed form is built (a large one is tens of MB parsed).
    return trimPackument(name, (await response.json()) as Packument, options.render === true);
  },

  renderMetadata(meta, keep, keptFiles, proxyBase) {
    const raw = meta.raw as NpmRenderData | undefined;
    if (!raw) throw new Error(`npm metadata for "${meta.name}" was fetched without render data`);
    const versions: Record<string, unknown> = {};
    const time: Record<string, string> = {};
    for (const version of keep) {
      const manifest = raw.manifests.get(version);
      if (manifest === undefined || !keptFiles.has(`${version}.tgz`)) continue;
      const info = JSON.parse(manifest) as Packument["versions"][string];
      versions[version] = {
        ...info,
        dist: { ...info.dist, tarball: `${proxyBase}-/tarball/${encodeURIComponent(meta.name)}/${version}` },
      };
      const published = raw.times.get(version);
      if (published !== undefined) time[version] = published;
    }
    const kept = Object.keys(versions);
    const tags = Object.fromEntries(Object.entries(raw.distTags).filter(([, version]) => kept.includes(version)));
    if (!tags.latest && kept.length > 0) tags.latest = semver.maxSatisfying(kept, "*") ?? kept[kept.length - 1];
    return {
      contentType: "application/json",
      body: JSON.stringify({ name: raw.name, "dist-tags": tags, time, versions }),
    };
  },

  resolveDownload(route: DownloadRoute, meta) {
    return meta.versions.get(route.version)?.files.find((file) => file.filename === route.filename) ?? null;
  },

  workerConfig({ registryUrl, token, cacheDir }) {
    const npmrc = `${cacheDir}/npmrc`;
    return {
      env: {
        npm_config_registry: registryUrl,
        npm_config_userconfig: npmrc,
        npm_config_ignore_scripts: "true",
        npm_config_cache: cacheDir,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
      files: [{ path: npmrc, content: `${registryUrl.replace(/^https?:/, "")}:_authToken=${token}\n`, mode: 0o600 }],
    };
  },
};
