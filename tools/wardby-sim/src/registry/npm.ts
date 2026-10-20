// TEST ONLY (wardby-sim). registry.npmjs.org, mounted at /npm (WARDBY_TEST_SIMULATORS rewrites
// https://registry.npmjs.org/... to <base>/npm/...). Answers come from npm-model.ts in its rich
// mode, with real .tgz tarballs (package/package.json + index.js) whose sha512 integrity and
// sha1 shasum are their own, so real npm, pnpm and yarn install them.
//
// Scripted: packages and versions, per-version publish `time` (the release-age rule), deprecations,
// a publish mid-scenario. `npm.self_tarballs` points dist.tarball at the simulator itself, for a
// client talking to the simulator directly (wardby's proxy rewrites the real host instead).
import { json, record, textOf, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";
import { npmTarball, sha1Hex, sha512Sri } from "./archive.js";
import {
  answerNpm,
  NPM_ORIGIN,
  standardNpmTarballUrl,
  type NpmRegistryModel,
  type NpmVersionSpec,
} from "./npm-model.js";

export const NPM_PREFIX = "/npm";

export class NpmState {
  model: NpmRegistryModel = {};
  defaultPublished = "2025-01-01T00:00:00.000Z";
  /** When set, dist.tarball points at `${selfBase}/npm/...` instead of registry.npmjs.org. */
  selfBase: string | null = null;
  private readonly tarballs = new Map<string, Buffer>();

  reset(): void {
    this.model = {};
    this.defaultPublished = "2025-01-01T00:00:00.000Z";
    this.selfBase = null;
    this.tarballs.clear();
  }

  tarball(name: string, version: string): Buffer {
    const key = `${name}@${version}`;
    let bytes = this.tarballs.get(key);
    if (!bytes) {
      const spec = this.model[name]?.[version] ?? {};
      bytes = npmTarball(name, version, {
        ...(spec.deps ? { dependencies: spec.deps } : {}),
        ...(spec.peer ? { peerDependencies: spec.peer } : {}),
        ...(spec.optional ? { optionalDependencies: spec.optional } : {}),
      });
      this.tarballs.set(key, bytes);
    }
    return bytes;
  }

  publish(name: string, version: string, spec: NpmVersionSpec): void {
    this.model[name] = { ...(this.model[name] ?? {}), [version]: spec };
    this.tarballs.delete(`${name}@${version}`);
  }
}

function specOf(value: unknown): NpmVersionSpec {
  const v = record(value);
  const deps = (key: string) => (v[key] && typeof v[key] === "object" ? (v[key] as Record<string, string>) : undefined);
  return {
    ...(deps("deps") ? { deps: deps("deps") } : {}),
    ...(deps("peer") ? { peer: deps("peer") } : {}),
    ...(deps("optional") ? { optional: deps("optional") } : {}),
    ...(typeof v.published === "string" ? { published: v.published } : {}),
    ...(typeof v.deprecated === "string" ? { deprecated: v.deprecated } : {}),
  };
}

export function createNpmService(): SimService {
  const npm = new NpmState();
  const handler = (req: SimRequest): SimResponse => {
    const answer = answerNpm(npm.model, req.path, {
      defaultPublished: npm.defaultPublished,
      tarballBytes: (name, version) => npm.tarball(name, version),
      integrity: sha512Sri,
      shasum: sha1Hex,
      rich: true,
    });
    if (answer.bytes) {
      return { status: 200, headers: { "content-type": "application/octet-stream" }, body: Buffer.from(answer.bytes) };
    }
    if (answer.json !== undefined) {
      let body = JSON.stringify(answer.json);
      if (npm.selfBase) body = body.replaceAll(`${NPM_ORIGIN}/`, `${npm.selfBase}${NPM_PREFIX}/`);
      return { status: 200, headers: { "content-type": "application/json" }, body };
    }
    // The real registry answers an unknown package with {"error":"Not found"}.
    return json({ error: answer.text === '"version not found"' ? "version not found" : "Not found" }, answer.status);
  };
  const router = new Router()
    .on("GET", "/{package}", handler)
    .on("GET", "/{package}/{version}", handler)
    .on("GET", "/{package}/-/{file}", handler)
    .on("GET", "/{scope}/{package}/-/{file}", handler);

  const actions: Record<string, ScriptAction> = {
    "npm.package": async (args) => {
      const name = textOf(args.name);
      if (!name) throw new Error("name is required");
      const versions = record(args.versions);
      for (const [version, spec] of Object.entries(versions)) npm.publish(name, version, specOf(spec));
      return { versions: Object.keys(npm.model[name] ?? {}) };
    },
    /** A publish mid-scenario: published now unless given. */
    "npm.publish": async (args) => {
      const name = textOf(args.name);
      const version = textOf(args.version);
      if (!name || !version) throw new Error("name and version are required");
      npm.publish(name, version, { published: new Date().toISOString(), ...specOf(args) });
      return { tarball: standardNpmTarballUrl(name, version), integrity: sha512Sri(npm.tarball(name, version)) };
    },
    "npm.deprecate": async (args) => {
      const spec = npm.model[textOf(args.name)]?.[textOf(args.version)];
      if (!spec) throw new Error("no such version");
      spec.deprecated = textOf(args.message, "deprecated");
      return {};
    },
    "npm.set_time": async (args) => {
      const spec = npm.model[textOf(args.name)]?.[textOf(args.version)];
      if (!spec) throw new Error("no such version");
      spec.published = textOf(args.published);
      return {};
    },
    "npm.default_published": async (args) => {
      npm.defaultPublished = textOf(args.published, npm.defaultPublished);
      return {};
    },
    "npm.self_tarballs": async (args) => {
      npm.selfBase = typeof args.base === "string" ? args.base.replace(/\/$/, "") : null;
      return {};
    },
  };

  return {
    name: "npm",
    prefix: NPM_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init: (state: SimState) => {
      if (!state.part("npm")) state.register("npm", npm);
    },
  };
}
