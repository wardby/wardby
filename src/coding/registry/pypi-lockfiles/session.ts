/**
 * The PyPI lockfile session of one coding run. `prepare` points existing uv
 * and Poetry projects at the proxy before the agent starts (uv.lock rewritten,
 * Poetry sources swapped and `poetry lock` run) and snapshots what it changed;
 * `restore` puts real addresses back before the workspace is collected, so
 * a pull request never carries a sandbox-only proxy URL. A uv.lock is pointed
 * back through the proxy's origins route, which needs no snapshot; Poetry
 * files come back from the snapshot. See uv-lockfile.ts and poetry-sources.ts
 * for the file formats.
 *
 * `prepare` is best effort: a failure leaves the files as found and becomes a
 * warning. `restore` is not: a uv.lock that still names the proxy afterwards is
 * reported as unresolved, and the caller fails the run.
 */
import { createHash } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readWorkspaceFile, rewriteWorkspaceFile, walkWorkspaceDirectories } from "../workspace-files.js";
import { runPoetryLock, type PoetryLockResult } from "./poetry-lock-runner.js";
import {
  isPoetryProject,
  poetryCredentialEnv,
  restorePoetryLockUrls,
  restorePoetrySources,
  swapPoetrySources,
  type PoetrySource,
} from "./poetry-sources.js";
import { originKey, ORIGIN_UNREACHABLE, resolvePypiOrigins, type OriginAnswers } from "./origins-client.js";
import {
  collectUvProxyReferences,
  isUvLock,
  restoreUvLockFromOrigins,
  rewriteUvLockToProxy,
  type UvProxyReferences,
} from "./uv-lockfile.js";

export const SNAPSHOT_PATH = ".cache/wardby-pypi-lockfiles.json";
const SNAPSHOT_VERSION = 1;
/** A file larger than this is left alone: the snapshot keeps its original content. */
const MAX_SNAPSHOT_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 180_000;
/** From this process into the `poetry lock` run; UV_PYTHON_* is how Poetry finds a baked interpreter the system Python lacks. */
const AGENT_PASSTHROUGH = ["PATH", "HOME", "LANG", "UV_PYTHON_INSTALL_DIR", "UV_PYTHON_DOWNLOADS"] as const;

type Kind = "uv" | "poetry-pyproject" | "poetry-lock";
const KIND_FILE: Record<Kind, string> = {
  uv: "uv.lock",
  "poetry-pyproject": "pyproject.toml",
  "poetry-lock": "poetry.lock",
};

interface SnapshotFile {
  /** Workspace-relative, `/` separated. */
  path: string;
  kind: Kind;
  original: string;
  /** sha256 of the content the session left in the file. */
  writtenSha256: string;
  files?: Record<string, string>;
  registries?: Record<string, string>;
  sources?: PoetrySource[];
}

interface Snapshot {
  schemaVersion: typeof SNAPSHOT_VERSION;
  files: SnapshotFile[];
}

export type PoetryRunner = (input: {
  projectDir: string;
  env: Record<string, string>;
  timeoutMs: number;
}) => Promise<PoetryLockResult>;

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");
const base = (registryUrl: string): string => (registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`);
const relative = (directory: string, name: string): string => (directory ? `${directory}/${name}` : name);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function parseSnapshot(raw: string): Snapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== SNAPSHOT_VERSION || !Array.isArray(value.files)) return null;
  const files: SnapshotFile[] = [];
  for (const entry of value.files as unknown[]) {
    if (!isRecord(entry)) return null;
    const { path, kind, original, writtenSha256, files: urlFiles, registries, sources } = entry;
    if (typeof path !== "string" || typeof original !== "string" || typeof writtenSha256 !== "string") return null;
    if (kind !== "uv" && kind !== "poetry-pyproject" && kind !== "poetry-lock") return null;
    // The restore only ever touches the three file names, wherever the snapshot says.
    if (path.split("/").pop() !== KIND_FILE[kind] || path.split("/").includes("..") || path.startsWith("/"))
      return null;
    if (urlFiles !== undefined && !isStringMap(urlFiles)) return null;
    if (registries !== undefined && !isStringMap(registries)) return null;
    if (
      sources !== undefined &&
      !(
        Array.isArray(sources) &&
        sources.every((s) => isRecord(s) && typeof s.name === "string" && typeof s.url === "string")
      )
    )
      return null;
    files.push({
      path,
      kind,
      original,
      writtenSha256,
      ...(urlFiles ? { files: urlFiles } : {}),
      ...(registries ? { registries } : {}),
      ...(sources ? { sources: sources as PoetrySource[] } : {}),
    });
  }
  return { schemaVersion: SNAPSHOT_VERSION, files };
}

async function readSnapshot(workspace: string): Promise<{ snapshot: Snapshot | null; unreadable: boolean }> {
  const raw = await readWorkspaceFile(join(workspace, SNAPSHOT_PATH), MAX_SNAPSHOT_BYTES);
  if (raw === null) return { snapshot: null, unreadable: false };
  const snapshot = parseSnapshot(raw);
  return { snapshot, unreadable: snapshot === null };
}

async function writeSnapshot(workspace: string, snapshot: Snapshot): Promise<void> {
  const path = join(workspace, SNAPSHOT_PATH);
  const temporary = `${path}.tmp`;
  await mkdir(join(workspace, ".cache"), { recursive: true, mode: 0o700 });
  // Created exclusively, then renamed over the old snapshot: never written through a symlink, and a failed
  // write (a full workspace volume) leaves the previous snapshot, which earlier rewrites depend on, intact.
  await rm(temporary, { force: true });
  try {
    await writeFile(temporary, JSON.stringify(snapshot), { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Puts the original content back in files this session rewrote; best effort, one failure does not stop the rest. */
async function rollBack(workspace: string, files: SnapshotFile[]): Promise<void> {
  for (const file of files) await overwrite(join(workspace, file.path), file.original).catch(() => false);
}

/** Writes `content` over a file the session owns; whether it took. */
const overwrite = (path: string, content: string): Promise<boolean> => rewriteWorkspaceFile(path, () => content);

async function prepareUv(
  workspace: string,
  path: string,
  registryUrl: string,
  existing: SnapshotFile | undefined,
  warnings: string[],
): Promise<SnapshotFile | null> {
  const absolute = join(workspace, path);
  const before = await readWorkspaceFile(absolute, MAX_SNAPSHOT_FILE_BYTES);
  if (before === null || !isUvLock(before)) return null;
  if (existing && existing.writtenSha256 === sha256(before)) return existing;
  const { content, files, registries } = rewriteUvLockToProxy(before, registryUrl);
  if (content === before) return null;
  if (!(await overwrite(absolute, content))) {
    warnings.push(`${path}: could not be rewritten for the proxy; left as found`);
    return null;
  }
  return { path, kind: "uv", original: before, writtenSha256: sha256(content), files, registries };
}

async function preparePoetry(
  workspace: string,
  directory: string,
  input: { registryUrl: string; env: Record<string, string>; token: string; lockTimeoutMs: number; run: PoetryRunner },
  existing: SnapshotFile[],
  warnings: string[],
): Promise<SnapshotFile[]> {
  const pyprojectPath = relative(directory, "pyproject.toml");
  const lockPath = relative(directory, "poetry.lock");
  const pyproject = await readWorkspaceFile(join(workspace, pyprojectPath), MAX_SNAPSHOT_FILE_BYTES);
  const lock = await readWorkspaceFile(join(workspace, lockPath), MAX_SNAPSHOT_FILE_BYTES);
  if (pyproject === null || lock === null || !isPoetryProject(pyproject)) return [];
  const known = existing.filter((file) => file.path === pyprojectPath || file.path === lockPath);
  if (known.some((file) => file.kind === "poetry-pyproject" && file.writtenSha256 === sha256(pyproject))) return known;
  const swap = swapPoetrySources(pyproject, `${base(input.registryUrl)}simple/`);
  if (swap.sources.length === 0) return [];
  if (!(await overwrite(join(workspace, pyprojectPath), swap.content))) {
    warnings.push(`${pyprojectPath}: could not be rewritten for the proxy; left as found`);
    return [];
  }
  const result: PoetryLockResult = await input
    .run({
      projectDir: join(workspace, directory),
      env: { ...input.env, ...poetryCredentialEnv(swap.sources, input.token) },
      timeoutMs: input.lockTimeoutMs,
    })
    .catch(() => ({ ok: false, reason: "failed" as const, stderrTail: "" }));
  if (!result.ok) {
    // Back to exactly what the repository had; the lock was not written.
    await overwrite(join(workspace, pyprojectPath), pyproject);
    if (result.reason !== "poetry_not_installed") {
      const detail = result.stderrTail.trim().split("\n").slice(-3).join(" | ");
      warnings.push(
        `${pyprojectPath}: poetry lock through the proxy ${result.reason ?? "failed"}; left as found${detail ? ` (${detail})` : ""}`,
      );
    }
    return [];
  }
  const relocked = await readWorkspaceFile(join(workspace, lockPath), MAX_SNAPSHOT_FILE_BYTES);
  const files: SnapshotFile[] = [
    {
      path: pyprojectPath,
      kind: "poetry-pyproject",
      original: pyproject,
      writtenSha256: sha256(swap.content),
      sources: swap.sources,
    },
  ];
  if (relocked !== null) {
    files.push({
      path: lockPath,
      kind: "poetry-lock",
      original: lock,
      writtenSha256: sha256(relocked),
      sources: swap.sources,
    });
  }
  return files;
}

/**
 * Before the agent starts. `env` is the agent's environment (the Poetry run gets it, plus PATH, HOME, LANG and UV_PYTHON_*
 * from this process); the returned `env` holds what the agent's shells additionally need (Poetry's source credentials).
 */
export async function prepareWorkspacePypiLockfiles(input: {
  workspace: string;
  /** The proxy's PyPI route, `registryUrlFor(proxyBaseUrl, "pypi")`. */
  registryUrl: string;
  /** The run's registry-only token. */
  token: string;
  env: Record<string, string>;
  run?: PoetryRunner;
  lockTimeoutMs?: number;
}): Promise<{ env: Record<string, string>; prepared: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const kept = new Map<string, SnapshotFile>();
  let known: SnapshotFile[] = [];
  /** Files this call rewrote, which a failure before their snapshot is saved must put back. */
  const rewritten = (): SnapshotFile[] => [...kept.values()].filter((file) => !known.includes(file));
  try {
    const { snapshot: previous } = await readSnapshot(input.workspace);
    known = previous?.files ?? [];
    const processEnv: Record<string, string> = {};
    for (const name of AGENT_PASSTHROUGH) {
      const value = process.env[name];
      if (value !== undefined) processEnv[name] = value;
    }
    const poetryInput = {
      registryUrl: input.registryUrl,
      env: { ...processEnv, ...input.env },
      token: input.token,
      lockTimeoutMs: input.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      run: input.run ?? runPoetryLock,
    };
    await walkWorkspaceDirectories(input.workspace, async (directory, fileNames) => {
      if (fileNames.includes("uv.lock")) {
        const path = relative(directory, "uv.lock");
        const file = await prepareUv(
          input.workspace,
          path,
          input.registryUrl,
          known.find((f) => f.path === path),
          warnings,
        );
        if (file) kept.set(path, file);
      }
      if (fileNames.includes("poetry.lock") && fileNames.includes("pyproject.toml")) {
        for (const file of await preparePoetry(input.workspace, directory, poetryInput, known, warnings)) {
          kept.set(file.path, file);
        }
      }
    });
    if (rewritten().length > 0) {
      const merged = new Map(known.map((file) => [file.path, file] as const));
      for (const [path, file] of kept) merged.set(path, file);
      await writeSnapshot(input.workspace, { schemaVersion: SNAPSHOT_VERSION, files: [...merged.values()] });
    }
    const sources = [...kept.values()].flatMap((file) =>
      file.kind === "poetry-pyproject" ? (file.sources ?? []) : [],
    );
    return {
      env: poetryCredentialEnv(sources, input.token),
      prepared: [...kept.keys()].sort(),
      warnings,
    };
  } catch {
    // Without a saved snapshot the restore could not undo these rewrites, so undo them here.
    await rollBack(input.workspace, rewritten());
    warnings.push("pypi lockfiles: preparing the workspace failed; files left as found");
    return { env: {}, prepared: [], warnings };
  }
}

function restoreContent(
  file: SnapshotFile,
  current: string,
  registryUrl: string,
): { content: string; warning?: string } {
  if (sha256(current) === file.writtenSha256) return { content: file.original };
  const index = `${base(registryUrl)}simple`;
  const sources = file.sources ?? [];
  if (file.kind === "poetry-pyproject") {
    const content = restorePoetrySources(current, sources, `${index}/`);
    return content.includes(index)
      ? { content, warning: "changed during the run; a source still names the proxy" }
      : { content };
  }
  return {
    content: restorePoetryLockUrls(current, sources, `${index}/`),
    warning: "changed during the run; run `poetry lock` to refresh its content-hash",
  };
}

/** A short, secret-free account of why a uv.lock's entries could not be pointed back: counts by code, a few project names. */
function describeUnresolved(
  references: UvProxyReferences,
  answers: OriginAnswers,
  unresolved: readonly string[],
): string {
  const left = new Set(unresolved);
  const codes = new Map<string, number>();
  const projects = new Set<string>();
  for (const file of references.files) {
    if (!left.has(file.url)) continue;
    const answer = answers.files.get(originKey(file));
    const code = answer && "error" in answer ? answer.error : "wardby_origin_unanswered";
    codes.set(code, (codes.get(code) ?? 0) + 1);
    projects.add(file.name);
  }
  // An index entry with no file entry above it (the proxy gave no index address).
  if (codes.size === 0)
    codes.set(answers.index === null ? ORIGIN_UNREACHABLE : "wardby_origin_unanswered", unresolved.length);
  const why = [...codes].map(([code, count]) => `${code} x${count}`).join(", ");
  const names = [...projects].sort().slice(0, 5).join(", ");
  return `${unresolved.length} entries still name the proxy (${why}${names ? `; projects: ${names}` : ""})`;
}

/**
 * Before collection: points each uv.lock the proxy touched back at real registry addresses, and puts the original
 * Poetry files back. Files are found by walking the workspace, never by the snapshot's paths.
 *
 * A uv.lock needs no snapshot. One the agent left as `prepare` wrote it is restored exactly from the snapshot. For any
 * other, every proxy URL still in it (an added or upgraded package included) is looked up through the proxy's origins
 * route (origins-client.ts) and replaced with the real address it answers; an entry the proxy cannot answer for falls back
 * to the snapshot's recorded original when the snapshot has one, and otherwise stays in `unresolved`. Poetry keeps using
 * the snapshot (a separate change moves it to the proxy too).
 *
 * `unresolved` names the uv.lock files that still carry proxy-only URLs: the caller must fail the run rather than
 * collect a workspace whose lock cannot install outside the sandbox. `token` is the run's registry token.
 */
export async function restoreWorkspacePypiLockfiles(input: {
  workspace: string;
  registryUrl: string;
  token: string;
  /** For tests; the process's fetch otherwise. */
  fetch?: typeof fetch;
}): Promise<{ restored: string[]; warnings: string[]; unresolved: string[] }> {
  const restored: string[] = [];
  const warnings: string[] = [];
  const unresolved: string[] = [];
  const { workspace, registryUrl } = input;

  async function restoreUv(path: string, file: SnapshotFile | undefined): Promise<void> {
    const absolute = join(workspace, path);
    const current = await readWorkspaceFile(absolute, MAX_SNAPSHOT_FILE_BYTES);
    if (current === null || !isUvLock(current)) return;
    // Left as prepare wrote it: back to exactly what the repository had.
    if (file && sha256(current) === file.writtenSha256) {
      if (await overwrite(absolute, file.original)) restored.push(path);
      return;
    }
    const references = collectUvProxyReferences(current, registryUrl);
    if (references.files.length === 0 && !references.registry) return;
    const answers = await resolvePypiOrigins({
      registryUrl,
      token: input.token,
      files: references.files,
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const files = new Map<string, string>();
    for (const reference of references.files) {
      const answer = answers.files.get(originKey(reference));
      if (answer && "url" in answer) files.set(reference.url, answer.url);
    }
    const result = restoreUvLockFromOrigins(current, registryUrl, {
      ...(answers.index !== null ? { index: answers.index } : {}),
      files,
      ...(file ? { fallback: { files: file.files ?? {}, registries: file.registries ?? {} } } : {}),
    });
    if (result.content !== current) {
      // Written only if the file is still what was read: the answer was computed from that text.
      if (await rewriteWorkspaceFile(absolute, (now) => (now === current ? result.content : null))) restored.push(path);
      else {
        warnings.push(`${path}: changed while it was being restored; left as found`);
        unresolved.push(path);
        return;
      }
    }
    if (result.unresolved.length > 0) {
      warnings.push(`${path}: ${describeUnresolved(references, answers, result.unresolved)}`);
      unresolved.push(path);
    }
  }

  try {
    const { snapshot, unreadable } = await readSnapshot(workspace);
    if (unreadable) warnings.push("pypi lockfiles: the snapshot is unreadable; files left as found");
    const byPath = new Map((snapshot?.files ?? []).map((file) => [file.path, file] as const));
    await walkWorkspaceDirectories(workspace, async (directory, fileNames) => {
      for (const name of fileNames) {
        const path = relative(directory, name);
        const file = byPath.get(path);
        if (name === "uv.lock") {
          try {
            await restoreUv(path, file?.kind === "uv" ? file : undefined);
          } catch {
            // Whatever failed, this lock may still name the proxy: never carry on as if it were done.
            warnings.push(`${path}: restoring it failed`);
            unresolved.push(path);
          }
          continue;
        }
        if (!file || file.kind === "uv" || KIND_FILE[file.kind] !== name) continue;
        let warning: string | undefined;
        const changed = await rewriteWorkspaceFile(join(workspace, path), (current) => {
          const result = restoreContent(file, current, registryUrl);
          warning = result.warning;
          return result.content;
        });
        if (changed) restored.push(path);
        if (warning) warnings.push(`${path}: ${warning}`);
      }
    });
  } catch {
    warnings.push("pypi lockfiles: restoring the workspace failed; files left as found");
  }
  return { restored: restored.sort(), warnings, unresolved: unresolved.sort() };
}
