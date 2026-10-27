// TEST ONLY (wardby-sim). pypi.org (mounted at /pypi: the JSON API and the simple index) and
// files.pythonhosted.org (mounted at /pypi-files), from pypi-model.ts in its rich mode: PEP 691
// JSON or PEP 503 HTML by Accept, real pure-Python wheels (pip and uv install them) and sdists,
// each with its own sha256; sdist-only, too-new (upload time under test control), yanked releases
// and extras. `pypi.self_files` points file URLs at the simulator, for a client talking to it
// directly (wardby's proxy rewrites the real hosts instead).
import { header, record, textOf, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";
import { pythonSdist, pythonWheel, sha256Hex } from "./archive.js";
import {
  answerPypi,
  PYPI_FILES_ORIGIN,
  PYPI_ORIGIN,
  type PypiRegistryModel,
  type PypiReleaseSpec,
} from "./pypi-model.js";

export const PYPI_PREFIX = "/pypi";
export const PYPI_FILES_PREFIX = "/pypi-files";

export class PypiState {
  model: PypiRegistryModel = {};
  defaultUploaded = "2025-01-01T00:00:00.000Z";
  selfBase: string | null = null;
  private readonly files = new Map<string, Buffer>();

  reset(): void {
    this.model = {};
    this.defaultUploaded = "2025-01-01T00:00:00.000Z";
    this.selfBase = null;
    this.files.clear();
  }

  wheel(name: string, version: string, release: PypiReleaseSpec): Buffer {
    const key = `whl:${name}@${version}`;
    let bytes = this.files.get(key);
    if (!bytes) {
      bytes = pythonWheel(name, version, release.requires ?? [], release.extras ?? []);
      this.files.set(key, bytes);
    }
    return bytes;
  }

  sdist(name: string, version: string): Buffer {
    const key = `sdist:${name}@${version}`;
    let bytes = this.files.get(key);
    if (!bytes) {
      bytes = pythonSdist(name, version);
      this.files.set(key, bytes);
    }
    return bytes;
  }
}

function releaseOf(value: unknown): PypiReleaseSpec {
  const v = record(value);
  return {
    ...(Array.isArray(v.requires) ? { requires: v.requires.map(String) } : {}),
    ...(typeof v.uploaded === "string" ? { uploaded: v.uploaded } : {}),
    ...(v.sdistOnly === true ? { sdistOnly: true } : {}),
    ...(Array.isArray(v.extras) ? { extras: v.extras.map(String) } : {}),
    ...(v.yanked === true ? { yanked: true } : {}),
    ...(typeof v.requiresPython === "string" ? { requiresPython: v.requiresPython } : {}),
  };
}

export function createPypiServices(): SimService[] {
  const pypi = new PypiState();
  const answer =
    (origin: string) =>
    (req: SimRequest): SimResponse => {
      const result = answerPypi(
        pypi.model,
        `${origin}${req.path}`,
        {
          defaultUploaded: pypi.defaultUploaded,
          wheelBytes: (name, version, release) => pypi.wheel(name, version, release),
          sdistBytes: (name, version) => pypi.sdist(name, version),
          sha256: sha256Hex,
          rich: true,
        },
        header(req, "accept") ?? "",
      );
      const rewrite = (text: string) =>
        pypi.selfBase ? text.replaceAll(`${PYPI_FILES_ORIGIN}/`, `${pypi.selfBase}${PYPI_FILES_PREFIX}/`) : text;
      if (result.bytes) {
        return {
          status: 200,
          headers: { "content-type": "application/octet-stream" },
          body: Buffer.from(result.bytes),
        };
      }
      if (result.json !== undefined) {
        const type = req.path.startsWith("/simple/") ? "application/vnd.pypi.simple.v1+json" : "application/json";
        return { status: 200, headers: { "content-type": type }, body: rewrite(JSON.stringify(result.json)) };
      }
      if (result.html !== undefined) {
        return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: rewrite(result.html) };
      }
      return { status: result.status, headers: { "content-type": "text/plain" }, body: "Not Found" };
    };
  const index = new Router()
    .on("GET", "/simple/{project}/", answer(PYPI_ORIGIN))
    .on("GET", "/pypi/{project}/json", answer(PYPI_ORIGIN))
    .on("GET", "/pypi/{project}/{version}/json", answer(PYPI_ORIGIN));
  const files = new Router().on("GET", "/packages/*", answer(PYPI_FILES_ORIGIN));

  const actions: Record<string, ScriptAction> = {
    "pypi.project": async (args) => {
      const name = textOf(args.name);
      if (!name) throw new Error("name is required");
      const releases = record(args.releases);
      pypi.model[name] = { ...(pypi.model[name] ?? {}) };
      for (const [version, release] of Object.entries(releases)) pypi.model[name][version] = releaseOf(release);
      return { releases: Object.keys(pypi.model[name]) };
    },
    "pypi.upload": async (args) => {
      const name = textOf(args.name);
      const version = textOf(args.version);
      if (!name || !version) throw new Error("name and version are required");
      pypi.model[name] = {
        ...(pypi.model[name] ?? {}),
        [version]: { uploaded: new Date().toISOString(), ...releaseOf(args) },
      };
      return {};
    },
    "pypi.yank": async (args) => {
      const release = pypi.model[textOf(args.name)]?.[textOf(args.version)];
      if (!release) throw new Error("no such release");
      release.yanked = true;
      return {};
    },
    "pypi.default_uploaded": async (args) => {
      pypi.defaultUploaded = textOf(args.uploaded, pypi.defaultUploaded);
      return {};
    },
    "pypi.self_files": async (args) => {
      pypi.selfBase = typeof args.base === "string" ? args.base.replace(/\/$/, "") : null;
      return {};
    },
  };

  const init = (state: SimState) => {
    if (!state.part("pypi")) state.register("pypi", pypi);
  };
  return [
    {
      name: "pypi",
      prefix: PYPI_PREFIX,
      handle: (req, ctx) => index.handle(req, ctx),
      routes: () => index.routes(),
      actions,
      init,
    },
    {
      name: "pypi-files",
      prefix: PYPI_FILES_PREFIX,
      handle: (req, ctx) => files.handle(req, ctx),
      routes: () => files.routes(),
      init,
    },
  ];
}
