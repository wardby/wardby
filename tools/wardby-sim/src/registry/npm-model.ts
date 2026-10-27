// TEST ONLY (wardby-sim). registry.npmjs.org's answers for a package model, shared by the
// simulator (registry/npm.ts) and the in-process fake the lockfile-plan unit tests use
// (src/providers/coding-proxy/registry/fake-registries.test-support.ts), so both answer alike.
//
// `rich` adds what the real registry also sends and the original unit-test fake left out:
// dist-tags, time.created/modified, a version's `deprecated` and `dist.shasum`.

export interface NpmVersionSpec {
  deps?: Record<string, string>;
  peer?: Record<string, string>;
  optional?: Record<string, string>;
  /** ISO publish time (the release-age rule reads it). */
  published?: string;
  /** The registry's tarball URL, when not the standard one. */
  tarball?: string;
  /** npm's deprecation message. */
  deprecated?: string;
}
export type NpmRegistryModel = Record<string, Record<string, NpmVersionSpec>>;

export const NPM_ORIGIN = "https://registry.npmjs.org";

export const standardNpmTarballUrl = (name: string, version: string): string =>
  `${NPM_ORIGIN}/${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;

export interface NpmAnswer {
  status: number;
  json?: unknown;
  text?: string;
  bytes?: Uint8Array;
}

export interface NpmAnswerOptions {
  defaultPublished: string;
  tarballBytes: (name: string, version: string) => Uint8Array;
  integrity: (bytes: Uint8Array) => string;
  shasum?: (bytes: Uint8Array) => string;
  rich?: boolean;
}

function manifest(
  name: string,
  version: string,
  spec: NpmVersionSpec,
  options: NpmAnswerOptions,
): Record<string, unknown> {
  const bytes = options.tarballBytes(name, version);
  return {
    name,
    version,
    dist: {
      integrity: options.integrity(bytes),
      tarball: spec.tarball ?? standardNpmTarballUrl(name, version),
      ...(options.rich && options.shasum ? { shasum: options.shasum(bytes) } : {}),
    },
    ...(spec.deps ? { dependencies: spec.deps } : {}),
    ...(spec.peer ? { peerDependencies: spec.peer } : {}),
    ...(spec.optional ? { optionalDependencies: spec.optional } : {}),
    ...(options.rich && spec.deprecated ? { deprecated: spec.deprecated } : {}),
  };
}

/** The answer to one request path on the registry ("/left-pad", "/@s%2fp", "/p/1.0.0", "/p/-/p-1.0.0.tgz"). */
export function answerNpm(model: NpmRegistryModel, path: string, options: NpmAnswerOptions): NpmAnswer {
  const url = `${NPM_ORIGIN}${path}`;
  const tarball = Object.entries(model)
    .flatMap(([name, versions]) => Object.keys(versions).map((version) => ({ name, version })))
    .find(({ name, version }) => standardNpmTarballUrl(name, version) === url);
  if (tarball) return { status: 200, bytes: options.tarballBytes(tarball.name, tarball.version) };
  const match = /^\/([^/]+)(?:\/([^/]+))?$/.exec(path);
  if (!match) return { status: 404, text: "no route" };
  const name = decodeURIComponent(match[1]);
  const versions = model[name];
  if (!versions) return { status: 404, text: "{}" };
  if (match[2]) {
    const version = decodeURIComponent(match[2]);
    return versions[version]
      ? { status: 200, json: manifest(name, version, versions[version], options) }
      : { status: 404, text: '"version not found"' };
  }
  const time = Object.fromEntries(
    Object.entries(versions).map(([version, info]) => [version, info.published ?? options.defaultPublished]),
  );
  if (!options.rich) {
    return {
      status: 200,
      json: {
        name,
        versions: Object.fromEntries(Object.keys(versions).map((v) => [v, manifest(name, v, versions[v], options)])),
        time,
      },
    };
  }
  const published = Object.values(time).sort();
  const latest = Object.entries(time)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .at(-1)?.[0];
  return {
    status: 200,
    json: {
      _id: name,
      name,
      ...(latest ? { "dist-tags": { latest } } : {}),
      versions: Object.fromEntries(Object.keys(versions).map((v) => [v, manifest(name, v, versions[v], options)])),
      time: { created: published[0], modified: published.at(-1), ...time },
    },
  };
}
