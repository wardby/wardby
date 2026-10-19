// What the uv shim (uv-shim.mjs) reads from a uv command line, and how it
// points a uv.lock's PyPI URLs at the registry proxy and back. Pure and
// dependency-free.
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Project commands that read the project's uv.lock. */
export const PROJECT_COMMANDS = new Set(["sync", "run", "add", "remove", "lock", "export", "tree"]);
/** Global options whose value is the next argument (the ones a command line puts before the command). */
const VALUE_OPTIONS = new Set([
  "--directory",
  "--project",
  "--cache-dir",
  "--config-file",
  "--color",
  "--python",
  "-p",
  "--allow-insecure-host",
  "--index",
  "--default-index",
  "--index-url",
  "-i",
  "--extra-index-url",
  "--find-links",
  "-f",
]);
const PYPI_INDEXES = ['"https://pypi.org/simple"', '"https://pypi.org/simple/"'];
const PYPI_FILES = /"https:\/\/files\.pythonhosted\.org\/packages\/[^"]*\/([^"/]+)"/g;

/** The value of `option` (`--project x` or `--project=x`), if given. */
function optionValue(args, ...options) {
  for (const option of options) {
    const at = args.indexOf(option);
    if (at >= 0 && args[at + 1]) return args[at + 1];
    const inline = args.find((arg) => arg.startsWith(`${option}=`));
    if (inline) return inline.slice(option.length + 1);
  }
  return undefined;
}

/** Positional arguments (neither options nor a value option's value). */
export function positionals(args) {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (VALUE_OPTIONS.has(arg) || arg === "-r" || arg === "--requirement" || arg === "-c" || arg === "--constraint")
      index += 1;
    else if (!arg.startsWith("-")) out.push(arg);
  }
  return out;
}

/** What the command line asks: the project lock it reads, or the requirement files it installs. */
export function planTargets(args, cwd = process.cwd()) {
  const [command, sub] = positionals(args);
  const base = resolve(cwd, optionValue(args, "--directory") ?? ".");
  if (command === "pip" && (sub === "install" || sub === "sync")) {
    const files = [];
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if ((arg === "-r" || arg === "--requirement") && args[index + 1]) files.push(args[index + 1]);
      else if (arg.startsWith("--requirement=")) files.push(arg.slice("--requirement=".length));
      else if (arg.startsWith("-r") && arg.length > 2) files.push(arg.slice(2).replace(/^=/, ""));
    }
    if (sub === "sync") files.push(...positionals(args).slice(2));
    return { requirements: files.map((file) => resolve(base, file)) };
  }
  if (!PROJECT_COMMANDS.has(command)) return {};
  return { lock: findLock(resolve(base, optionValue(args, "--project") ?? ".")) };
}

/** The nearest uv.lock from `directory` up, stopping at a repository root. */
function findLock(directory) {
  for (let current = directory; ;) {
    const path = join(current, "uv.lock");
    if (existsSync(path)) return path;
    const parent = dirname(current);
    if (existsSync(join(current, ".git")) || parent === current) return { missing: join(directory, "uv.lock") };
    current = parent;
  }
}

/** The proxy's index URL without credentials (with its trailing `/`) and its file route, from UV_DEFAULT_INDEX. */
export function proxyUrls(env = process.env) {
  if (!env.UV_DEFAULT_INDEX) return undefined;
  let url;
  try {
    url = new URL(env.UV_DEFAULT_INDEX);
  } catch {
    return undefined;
  }
  url.username = "";
  url.password = "";
  const index = url.toString().endsWith("/") ? url.toString() : `${url.toString()}/`;
  if (!index.endsWith("/simple/")) return undefined;
  return { index, files: `${index.slice(0, -"simple/".length)}files/` };
}

/** PyPI's own path for a file by project and filename, which redirects to it (as normalizeUvLock in pypi-plan.ts). */
export function publicFileUrl(name, filename) {
  if (!/^(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])$/.test(name) || !/^[A-Za-z0-9._+!-]+$/.test(filename))
    return undefined;
  let tag = "source";
  if (filename.endsWith(".whl")) {
    const parts = filename.slice(0, -".whl".length).split("-");
    if (parts.length < 5) return undefined;
    tag = parts[parts.length - 3];
  } else if (!/\.(?:tar\.gz|zip)$/.test(filename)) return undefined;
  return `https://files.pythonhosted.org/packages/${tag}/${name[0]}/${name}/${filename}`;
}

/** A uv.lock with its PyPI index and file URLs pointed at the proxy, and each original file URL by filename. */
export function routeLock(text, proxy) {
  const originals = new Map();
  let name;
  const lines = text.split("\n").map((line) => {
    if (line === "[[package]]") name = undefined;
    const declared = line.match(/^name = "([^"]+)"$/);
    if (declared) name = declared[1];
    let routed = line;
    for (const index of PYPI_INDEXES) routed = routed.split(index).join(`"${proxy.index}"`);
    if (!name) return routed;
    return routed.replace(PYPI_FILES, (match, filename) => {
      originals.set(filename, match.slice(1, -1));
      return `"${proxy.files}${encodeURIComponent(name)}/${encodeURIComponent(filename)}"`;
    });
  });
  return { text: lines.join("\n"), originals };
}

/** A uv.lock with the proxy's URLs mapped back to PyPI's: a known file to its original URL, any other to publicFileUrl. */
export function unrouteLock(text, proxy, originals = new Map()) {
  const indexes = [proxy.index, proxy.index.slice(0, -1)];
  let out = text;
  for (const index of indexes) out = out.split(`"${index}"`).join('"https://pypi.org/simple"');
  const files = proxy.files.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return out.replace(new RegExp(`"${files}([^/"]+)/([^/"]+)"`, "g"), (match, rawName, rawFile) => {
    let name;
    let filename;
    try {
      name = decodeURIComponent(rawName);
      filename = decodeURIComponent(rawFile);
    } catch {
      return match;
    }
    const url = originals.get(filename) ?? publicFileUrl(name, filename);
    return url ? `"${url}"` : match;
  });
}
