/**
 * Fake upstream registries for the lockfile-plan tests (plan.test.ts, pypi-plan.test.ts) and the
 * release suite's package-policy matrix (src/release/packages.release.test.ts): a fake npm
 * registry (per-version documents, full packuments for publish times, tarballs) and a fake PyPI
 * (the per-release JSON API, the simple index, wheel files).
 */
import { createHash } from "node:crypto";
import type { UpstreamFetch } from "../../../coding/registry/types.js";

export interface FakeVersion {
  deps?: Record<string, string>;
  peer?: Record<string, string>;
  optional?: Record<string, string>;
  published?: string;
  /** The registry's tarball URL, when not the standard one. */
  tarball?: string;
}
export type FakeRegistry = Record<string, Record<string, FakeVersion>>;

export const tarballOf = (name: string, version: string) => new TextEncoder().encode(`tarball ${name}@${version}`);
export const sriOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const tarballUrl = (name: string, version: string) =>
  `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf("/") + 1)}-${version}.tgz`;

/** A fake registry.npmjs.org; a version without `published` was published at `defaultPublished`. */
export function fakeNpmRegistry(registry: FakeRegistry, defaultPublished: string) {
  const calls: string[] = [];
  const upstream: UpstreamFetch = async (url) => {
    calls.push(url);
    const tarball = Object.entries(registry)
      .flatMap(([name, versions]) => Object.keys(versions).map((version) => ({ name, version })))
      .find(({ name, version }) => tarballUrl(name, version) === url);
    if (tarball) return new Response(tarballOf(tarball.name, tarball.version));
    const match = url.match(/^https:\/\/registry\.npmjs\.org\/([^/]+)(?:\/([^/]+))?$/);
    if (!match) return new Response("no route", { status: 404 });
    const name = decodeURIComponent(match[1]);
    const versions = registry[name];
    if (!versions) return new Response("{}", { status: 404 });
    const manifest = (version: string) => ({
      name,
      version,
      dist: {
        integrity: sriOf(tarballOf(name, version)),
        tarball: versions[version].tarball ?? tarballUrl(name, version),
      },
      ...(versions[version].deps ? { dependencies: versions[version].deps } : {}),
      ...(versions[version].peer ? { peerDependencies: versions[version].peer } : {}),
      ...(versions[version].optional ? { optionalDependencies: versions[version].optional } : {}),
    });
    if (match[2]) {
      const version = decodeURIComponent(match[2]);
      return versions[version]
        ? Response.json(manifest(version))
        : new Response('"version not found"', { status: 404 });
    }
    return Response.json({
      name,
      versions: Object.fromEntries(Object.keys(versions).map((version) => [version, manifest(version)])),
      time: Object.fromEntries(
        Object.entries(versions).map(([version, info]) => [version, info.published ?? defaultPublished]),
      ),
    });
  };
  return { upstream, calls };
}

export interface FakeRelease {
  requires?: string[];
  uploaded?: string;
  /** Only an sdist. */
  sdistOnly?: boolean;
}
export type FakePypi = Record<string, Record<string, FakeRelease>>;

export const wheelBytes = new TextEncoder().encode("wheel bytes");
export const wheelSha256 = createHash("sha256").update(wheelBytes).digest("hex");
export const wheelName = (name: string, version: string) => `${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`;
export const pypiFileUrl = (filename: string) => `https://files.pythonhosted.org/packages/ab/cd/${filename}`;

/** A fake pypi.org and files.pythonhosted.org; a release without `uploaded` was uploaded at `defaultUploaded`. */
export function fakePypiRegistry(pypi: FakePypi, defaultUploaded: string) {
  const calls: string[] = [];
  const upstream: UpstreamFetch = async (url) => {
    calls.push(url);
    const json = url.match(/^https:\/\/pypi\.org\/pypi\/([^/]+)\/([^/]+)\/json$/);
    if (json) {
      const [name, version] = [decodeURIComponent(json[1]), decodeURIComponent(json[2])];
      const release = pypi[name]?.[version];
      if (!release) return new Response("{}", { status: 404 });
      const files = release.sdistOnly
        ? [
            {
              packagetype: "sdist",
              filename: `${name}-${version}.tar.gz`,
              url: pypiFileUrl(`${name}-${version}.tar.gz`),
            },
          ]
        : [
            {
              packagetype: "bdist_wheel",
              filename: wheelName(name, version),
              url: pypiFileUrl(wheelName(name, version)),
              yanked: false,
              upload_time_iso_8601: release.uploaded ?? defaultUploaded,
              digests: { sha256: wheelSha256 },
            },
          ];
      return Response.json({ info: { name, version, requires_dist: release.requires ?? null }, urls: files });
    }
    const simple = url.match(/^https:\/\/pypi\.org\/simple\/([^/]+)\/$/);
    if (simple) {
      const versions = pypi[simple[1]];
      if (!versions) return new Response("{}", { status: 404 });
      return Response.json({
        name: simple[1],
        files: Object.entries(versions).map(([version, release]) => ({
          filename: release.sdistOnly ? `${simple[1]}-${version}.tar.gz` : wheelName(simple[1], version),
          url: pypiFileUrl(wheelName(simple[1], version)),
          hashes: { sha256: wheelSha256 },
          "upload-time": release.uploaded ?? defaultUploaded,
          size: wheelBytes.byteLength,
        })),
      });
    }
    if (url.startsWith("https://files.pythonhosted.org/")) return new Response(wheelBytes);
    return new Response("no route", { status: 404 });
  };
  return { upstream, calls };
}
