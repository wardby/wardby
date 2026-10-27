/**
 * Fake upstream registries for the lockfile-plan tests (plan.test.ts, pypi-plan.test.ts) and the
 * release suite's package-policy matrix (src/release/packages.release.test.ts): a fake npm
 * registry (per-version documents, full packuments for publish times, tarballs) and a fake PyPI
 * (the per-release JSON API, the simple index, wheel files).
 */
import { createHash } from "node:crypto";
import type { UpstreamFetch } from "../../../coding/registry/types.js";
import {
  answerNpm,
  NPM_ORIGIN,
  standardNpmTarballUrl,
  type NpmRegistryModel,
  type NpmVersionSpec,
} from "../../../../tools/wardby-sim/src/registry/npm-model.js";
import {
  answerPypi,
  pypiFileUrlFor,
  wheelFileName,
  type PypiRegistryModel,
  type PypiReleaseSpec,
} from "../../../../tools/wardby-sim/src/registry/pypi-model.js";

export type FakeVersion = NpmVersionSpec;
export type FakeRegistry = NpmRegistryModel;

export const tarballOf = (name: string, version: string) => new TextEncoder().encode(`tarball ${name}@${version}`);
export const sriOf = (bytes: Uint8Array) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
export const tarballUrl = standardNpmTarballUrl;

/**
 * A fake registry.npmjs.org; a version without `published` was published at `defaultPublished`.
 * Its answers are the wardby-sim simulator's own (tools/wardby-sim/src/registry/npm-model.ts),
 * without the simulator's extra fields.
 */
export function fakeNpmRegistry(registry: FakeRegistry, defaultPublished: string) {
  const calls: string[] = [];
  const upstream: UpstreamFetch = async (url) => {
    calls.push(url);
    if (!url.startsWith(`${NPM_ORIGIN}/`)) return new Response("no route", { status: 404 });
    const answer = answerNpm(registry, url.slice(NPM_ORIGIN.length), {
      defaultPublished,
      tarballBytes: tarballOf,
      integrity: sriOf,
    });
    if (answer.bytes) return new Response(answer.bytes);
    if (answer.json !== undefined) return Response.json(answer.json);
    return new Response(answer.text, { status: answer.status });
  };
  return { upstream, calls };
}

export type FakeRelease = PypiReleaseSpec;
export type FakePypi = PypiRegistryModel;

export const wheelBytes = new TextEncoder().encode("wheel bytes");
export const wheelSha256 = createHash("sha256").update(wheelBytes).digest("hex");
export const wheelName = wheelFileName;
export const pypiFileUrl = pypiFileUrlFor;

/**
 * A fake pypi.org and files.pythonhosted.org; a release without `uploaded` was uploaded at
 * `defaultUploaded`. Its answers are the wardby-sim simulator's own
 * (tools/wardby-sim/src/registry/pypi-model.ts) in its plain mode.
 */
export function fakePypiRegistry(pypi: FakePypi, defaultUploaded: string) {
  const calls: string[] = [];
  const upstream: UpstreamFetch = async (url) => {
    calls.push(url);
    const answer = answerPypi(pypi, url, {
      defaultUploaded,
      wheelBytes: () => wheelBytes,
      sha256: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    });
    if (answer.bytes) return new Response(answer.bytes);
    if (answer.json !== undefined) return Response.json(answer.json);
    return new Response(answer.text, { status: answer.status });
  };
  return { upstream, calls };
}
