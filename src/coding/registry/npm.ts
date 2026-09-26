/**
 * npm registry adapter: parses npm allowlist syntax and semver ranges,
 * routes proxy requests against the npm HTTP protocol (packuments and
 * `-/tarball/<name>/<version>` downloads), and configures npm/npmrc for
 * the sandboxed worker to use the proxy with install-time scripts disabled.
 */
import semver from "semver";
import { npmLockfiles } from "./npm-lockfile.js";
import {
  AllowlistEntryError,
  RegistryError,
  type AllowlistEntry,
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

function validName(name: string): string {
  if (!NAME.test(name)) throw new AllowlistEntryError(`"${name}" is not a valid npm package name`);
  return name;
}

export const npmAdapter: RegistryAdapter = {
  id: "npm",
  osvEcosystem: "npm",
  upstreamHosts: ["registry.npmjs.org"],
  collectExclude: ["node_modules"],
  lockfiles: npmLockfiles,

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
    try {
      if (tarball) {
        const name = decodeURIComponent(tarball[1]);
        const version = decodeURIComponent(tarball[2]);
        if (!NAME.test(name) || !semver.valid(version)) return null;
        return { kind: "download", name, version, filename: `${version}.tgz` };
      }
      const name = decodeURIComponent(subpath);
      return NAME.test(name) ? { kind: "metadata", name } : null;
    } catch {
      throw new RegistryError(400, "wardby_bad_request", "malformed percent-encoding in the registry path");
    }
  },

  async fetchMetadata(name, upstream): Promise<PackageMetadata> {
    const response = await upstream(`${UPSTREAM}${name.replaceAll("/", "%2f")}`, { accept: "application/json" });
    if (response.status === 404)
      throw new RegistryError(404, "wardby_package_not_found", `npm has no package "${name}"`);
    if (!response.ok) throw new RegistryError(502, "wardby_upstream_error", `npm returned ${response.status}`);
    const doc = (await response.json()) as Packument;
    const versions = new Map<string, VersionInfo>();
    const raw: Packument = { name: doc.name, "dist-tags": doc["dist-tags"], time: {}, versions: {} };
    for (const [version, info] of Object.entries(doc.versions ?? {})) {
      raw.versions[version] = abbreviated(info);
      if (doc.time?.[version]) raw.time![version] = doc.time[version];
      const published = doc.time?.[version];
      const dependencies = [
        ...new Set(
          [info.dependencies, info.optionalDependencies, info.peerDependencies].flatMap((deps) =>
            Object.keys(deps ?? {}),
          ),
        ),
      ];
      const file: FileRef = {
        filename: `${version}.tgz`,
        version,
        upstreamUrl: info.dist.tarball,
        integrity: integrityOf(info.dist),
        sizeBytes: null,
        allowed: true,
        publishedAt: published ? new Date(published) : null,
      };
      versions.set(version, {
        version,
        dependencies,
        files: [file],
      });
    }
    return { name, versions, raw };
  },

  renderMetadata(meta, keep, keptFiles, proxyBase) {
    const raw = meta.raw as Packument;
    const versions: Packument["versions"] = {};
    for (const version of keep) {
      const info = raw.versions[version];
      if (!info || !keptFiles.has(`${version}.tgz`)) continue;
      versions[version] = {
        ...info,
        dist: { ...info.dist, tarball: `${proxyBase}-/tarball/${encodeURIComponent(meta.name)}/${version}` },
      };
    }
    const kept = Object.keys(versions);
    const tags = Object.fromEntries(
      Object.entries(raw["dist-tags"] ?? {}).filter(([, version]) => kept.includes(version)),
    );
    if (!tags.latest && kept.length > 0) tags.latest = semver.maxSatisfying(kept, "*") ?? kept[kept.length - 1];
    const time = Object.fromEntries(Object.entries(raw.time ?? {}).filter(([key]) => kept.includes(key)));
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
