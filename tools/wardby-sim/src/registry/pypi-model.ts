// TEST ONLY (wardby-sim). pypi.org's JSON API and simple index, and files.pythonhosted.org,
// for a package model; shared by the simulator (registry/pypi.ts) and the in-process fake the
// lockfile-plan unit tests use (src/providers/coding-proxy/registry/fake-registries.test-support.ts).
//
// Without `rich` the answers are exactly the original unit-test fake's (one wheel per release,
// fixed bytes, a JSON-only simple index). With `rich`, the simulator's: PEP 503 normalized
// names, project and release JSON, PEP 691 JSON or PEP 503 HTML by Accept, real wheels and
// sdists with their own sha256, yanked releases, requires-python, 404 for unknown files.

export interface PypiReleaseSpec {
  requires?: string[];
  uploaded?: string;
  /** Only an sdist. */
  sdistOnly?: boolean;
  /** Extras the release provides (Provides-Extra). */
  extras?: string[];
  yanked?: boolean;
  requiresPython?: string;
}
export type PypiRegistryModel = Record<string, Record<string, PypiReleaseSpec>>;

export const PYPI_ORIGIN = "https://pypi.org";
export const PYPI_FILES_ORIGIN = "https://files.pythonhosted.org";
export const SIMPLE_JSON = "application/vnd.pypi.simple.v1+json";

export const wheelFileName = (name: string, version: string): string =>
  `${name.replace(/-/g, "_")}-${version}-py3-none-any.whl`;
export const pypiFileUrlFor = (filename: string): string => `${PYPI_FILES_ORIGIN}/packages/ab/cd/${filename}`;

export interface PypiAnswer {
  status: number;
  json?: unknown;
  text?: string;
  html?: string;
  bytes?: Uint8Array;
}

export interface PypiAnswerOptions {
  defaultUploaded: string;
  wheelBytes: (name: string, version: string, release: PypiReleaseSpec) => Uint8Array;
  sdistBytes?: (name: string, version: string) => Uint8Array;
  sha256: (bytes: Uint8Array) => string;
  rich?: boolean;
}

const normalize = (name: string) => name.toLowerCase().replace(/[-_.]+/g, "-");

interface FileEntry {
  filename: string;
  packagetype: "bdist_wheel" | "sdist";
  bytes: Uint8Array;
  version: string;
  release: PypiReleaseSpec;
}

function filesOf(name: string, version: string, release: PypiReleaseSpec, options: PypiAnswerOptions): FileEntry[] {
  const sdist: FileEntry = {
    filename: `${name}-${version}.tar.gz`,
    packagetype: "sdist",
    bytes: options.sdistBytes?.(name, version) ?? new Uint8Array(),
    version,
    release,
  };
  if (release.sdistOnly) return [sdist];
  const wheel: FileEntry = {
    filename: wheelFileName(name, version),
    packagetype: "bdist_wheel",
    bytes: options.wheelBytes(name, version, release),
    version,
    release,
  };
  return options.rich ? [wheel, sdist] : [wheel];
}

export function answerPypi(model: PypiRegistryModel, url: string, options: PypiAnswerOptions, accept = ""): PypiAnswer {
  const lookup = (raw: string): [string, Record<string, PypiReleaseSpec>] | undefined => {
    if (!options.rich) return model[raw] ? [raw, model[raw]] : undefined;
    const key = Object.keys(model).find((name) => normalize(name) === normalize(raw));
    return key ? [key, model[key]] : undefined;
  };
  const uploadedOf = (release: PypiReleaseSpec) => release.uploaded ?? options.defaultUploaded;

  const releaseJson = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/([^/]+)\/json$/.exec(url);
  const projectJson = options.rich ? /^https:\/\/pypi\.org\/pypi\/([^/]+)\/json$/.exec(url) : null;
  if (releaseJson || projectJson) {
    const found = lookup(decodeURIComponent((releaseJson ?? projectJson)![1]));
    if (!found) return { status: 404, text: "{}" };
    const [name, releases] = found;
    const version = releaseJson
      ? decodeURIComponent(releaseJson[2])
      : Object.entries(releases)
          .sort((a, b) => uploadedOf(a[1]).localeCompare(uploadedOf(b[1])))
          .at(-1)?.[0];
    const release = version !== undefined ? releases[version] : undefined;
    if (!release || version === undefined) return { status: 404, text: "{}" };
    const urls = filesOf(name, version, release, options).map((file) =>
      file.packagetype === "sdist" && !options.rich
        ? { packagetype: "sdist", filename: file.filename, url: pypiFileUrlFor(file.filename) }
        : {
            packagetype: file.packagetype,
            filename: file.filename,
            url: pypiFileUrlFor(file.filename),
            yanked: release.yanked === true,
            upload_time_iso_8601: uploadedOf(release),
            digests: { sha256: options.sha256(file.bytes) },
            ...(options.rich ? { size: file.bytes.byteLength, requires_python: release.requiresPython ?? null } : {}),
          },
    );
    const info = {
      name,
      version,
      requires_dist: release.requires ?? null,
      ...(options.rich
        ? {
            requires_python: release.requiresPython ?? null,
            provides_extra: release.extras ?? [],
            yanked: release.yanked === true,
          }
        : {}),
    };
    if (projectJson) {
      const all = Object.fromEntries(
        Object.entries(releases).map(([v, r]) => [
          v,
          filesOf(name, v, r, options).map((file) => ({
            filename: file.filename,
            packagetype: file.packagetype,
            url: pypiFileUrlFor(file.filename),
            upload_time_iso_8601: uploadedOf(r),
            digests: { sha256: options.sha256(file.bytes) },
            yanked: r.yanked === true,
          })),
        ]),
      );
      return { status: 200, json: { info, urls, releases: all } };
    }
    return { status: 200, json: { info, urls } };
  }

  const simple = /^https:\/\/pypi\.org\/simple\/([^/]+)\/$/.exec(url);
  if (simple) {
    const found = lookup(simple[1]);
    if (!found) return { status: 404, text: "{}" };
    const [name, releases] = found;
    if (!options.rich) {
      const wheel = (version: string) => options.wheelBytes(name, version, releases[version]);
      return {
        status: 200,
        json: {
          name: simple[1],
          files: Object.entries(releases).map(([version, release]) => ({
            filename: release.sdistOnly ? `${simple[1]}-${version}.tar.gz` : wheelFileName(simple[1], version),
            url: pypiFileUrlFor(wheelFileName(simple[1], version)),
            hashes: { sha256: options.sha256(wheel(version)) },
            "upload-time": uploadedOf(release),
            size: wheel(version).byteLength,
          })),
        },
      };
    }
    const files = Object.entries(releases).flatMap(([version, release]) => filesOf(name, version, release, options));
    if (accept.includes(SIMPLE_JSON)) {
      return {
        status: 200,
        json: {
          meta: { "api-version": "1.1" },
          name: normalize(name),
          versions: Object.keys(releases),
          files: files.map((file) => ({
            filename: file.filename,
            url: pypiFileUrlFor(file.filename),
            hashes: { sha256: options.sha256(file.bytes) },
            ...(file.release.requiresPython ? { "requires-python": file.release.requiresPython } : {}),
            "upload-time": uploadedOf(file.release),
            size: file.bytes.byteLength,
            yanked: file.release.yanked === true,
          })),
        },
      };
    }
    const anchors = files
      .map((file) => {
        const rp = file.release.requiresPython
          ? ` data-requires-python="${file.release.requiresPython.replace(/</g, "&lt;").replace(/>/g, "&gt;")}"`
          : "";
        const yanked = file.release.yanked ? ' data-yanked=""' : "";
        return `<a href="${pypiFileUrlFor(file.filename)}#sha256=${options.sha256(file.bytes)}"${rp}${yanked}>${file.filename}</a><br/>`;
      })
      .join("\n");
    return {
      status: 200,
      html: `<!DOCTYPE html>\n<html><head><meta name="pypi:repository-version" content="1.1"><title>Links for ${normalize(name)}</title></head><body><h1>Links for ${normalize(name)}</h1>\n${anchors}\n</body></html>\n`,
    };
  }

  if (url.startsWith(`${PYPI_FILES_ORIGIN}/`)) {
    if (!options.rich) {
      return { status: 200, bytes: options.wheelBytes("", "", {}) };
    }
    const filename = decodeURIComponent(url.split("/").at(-1) ?? "");
    for (const [name, releases] of Object.entries(model)) {
      for (const [version, release] of Object.entries(releases)) {
        const file = filesOf(name, version, release, options).find((f) => f.filename === filename);
        if (file && url === pypiFileUrlFor(file.filename)) return { status: 200, bytes: file.bytes };
      }
    }
    return { status: 404, text: "Not Found" };
  }
  return { status: 404, text: "no route" };
}
