import { constants } from "node:fs";
import { lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, posix } from "node:path";
import type { Readable } from "node:stream";
import { COMMIT_SHA } from "../../coding/protocol.js";
import { redactSecrets } from "../../coding/redact.js";

/**
 * A history run's result bundle (#536), imported into the control plane's own git dir. The bundle is
 * untrusted bytes the worker wrote: it is read with git, never trusted, and nothing from it (git's
 * stderr included) ever reaches an error message. Every failure is one of the fixed codes below.
 */

/** At most this many new commits in one run's result. */
export const MAX_RESULT_COMMITS = 500;
/** At most this many bytes in one result commit's message. */
export const MAX_RESULT_MESSAGE_BYTES = 64 * 1024;
/** The single head the worker names in its bundle. */
export const RESULT_BUNDLE_HEAD_REF = "refs/wardby/bundle-head";
/** The bundle's head, as fetched (the agent's own commits; never pushed). */
export const RESULT_RAW_REF = "refs/wardby/result-raw";
/** The rewritten head. */
export const RESULT_REWRITTEN_REF = "refs/wardby/result-rewritten";
/** The final tip a finalize pushed (the rewritten head, plus the uncommitted files on top). */
export const RESULT_REF = "refs/wardby/result";
/** Who every rewritten commit is by. */
export const WARDBY_IDENTITY = { name: "Wardby", email: "wardby@users.noreply.github.com" } as const;

/** The object check and the fetch each read the whole bundle: five minutes. */
const BUNDLE_FETCH_TIMEOUT_MS = 300_000;
/** A bundle's header: its signature, capabilities, prerequisites and one ref, then a blank line. */
const BUNDLE_HEADER_MAX_BYTES = 1024 * 1024;
/** One prerequisite line per boundary commit of `head --not base tips`. */
const BUNDLE_PREREQUISITES_MAX = 10_000;
/** `index-pack` prints one `pack\t<hash>` line. */
const INDEX_PACK_MAX_BYTES = 4096;
/** Any other git call on the bundle's objects. */
const GIT_STEP_TIMEOUT_MS = 60_000;
/** `bundle list-heads` of a one-head bundle is one short line. */
const LIST_HEADS_MAX_BYTES = 4096;
/** One commit object: the message limit plus generous room for its headers (a signature, a merge tag). */
const COMMIT_OBJECT_MAX_BYTES = MAX_RESULT_MESSAGE_BYTES + 192 * 1024;
/** A symlink's target, read to check it stays inside the repository. */
const SYMLINK_TARGET_MAX_BYTES = 4096;
/** The name lists of one commit's changes. */
const NAME_LIST_MAX_BYTES = 2 * 1024 * 1024;

const GITLINK_MODE = "160000";
const SYMLINK_MODE = "120000";
const AUTHOR_DATE = / (\d{1,15}) ([+-]\d{4})$/;

export interface ResultGitOptions {
  maxOutputBytes?: number;
  timeoutMs?: number;
  input?: string | Readable;
  env?: Readonly<Record<string, string>>;
}

/** A git command bound to the control plane's own git dir and work tree. */
export type ResultGit = (args: string[], options?: ResultGitOptions) => Promise<{ stdout: string }>;

export interface ImportedHistory {
  /** The rewritten head (also at RESULT_REWRITTEN_REF). */
  tip: string;
  /** Every path some new commit changed against all its parents: the agent's own changes. */
  agentPaths: string[];
  /** The bytes of every new commit's own diff (a merge's combined diff). */
  agentDiffBytes: number;
  /** The agent's paths of each merge commit, for the conflict-marker check. */
  mergePaths: string[];
}

export interface ImportResultBundleOptions {
  git: ResultGit;
  bundlePath: string;
  /** The run's starting commit: baseCommit, or M0 when a target merge was committed. */
  historyBase: string;
  /** The remote links' fetched tips: a new commit may have one as a parent, never an older commit of theirs. */
  remoteTips: readonly string[];
  runId: string;
  /** The provider's diff limit, over every new commit's diff together. */
  maxDiffBytes: number;
  /** The provider's changed-file limit, over the union of the agent's paths. */
  maxChangedFiles: number;
}

/** A changed path as git names it: relative, no empty, `.` or `..` part, no backslash. */
export function validateChangedPath(path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error("vcs_changed_path_invalid");
  }
  return path;
}

function fail(code: string, cause?: unknown): never {
  // The cause is only ever another fixed code: git's own error carries its stderr, which may quote
  // the bundle, so it is dropped.
  const safeCause = cause instanceof Error && /^[a-z_]+$/.test(cause.message) ? cause : undefined;
  throw new Error(code, safeCause ? { cause: safeCause } : undefined);
}

function isOutputLimit(error: unknown): boolean {
  return error instanceof Error && error.message.includes("git_output_limit");
}

async function step<T>(code: string, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && /^vcs_[a-z_]+$/.test(error.message)) throw error;
    fail(code);
  }
}

interface NewCommit {
  sha: string;
  parents: string[];
}

/**
 * Imports a result bundle (spec "Finalizing", steps 1 to 5): fetches its one head, checks the new
 * commits' history and text, rewrites them as Wardby with their trees, messages and author dates
 * kept, and works out the agent's own paths and diff size. Throws vcs_result_bundle_invalid,
 * vcs_result_history_invalid, vcs_result_commit_limit, vcs_result_commit_unsafe, or one of the
 * workspace checks' codes (vcs_changed_path_invalid, vcs_nested_repository, vcs_symlink_escape,
 * vcs_changed_file_limit, vcs_diff_size_limit).
 */
export async function importResultBundle(options: ImportResultBundleOptions): Promise<ImportedHistory> {
  const { git, historyBase, remoteTips } = options;
  if (!COMMIT_SHA.test(historyBase) || remoteTips.some((tip) => !COMMIT_SHA.test(tip))) {
    throw new Error("vcs_workspace_handle_invalid");
  }
  const head = await fetchBundle(git, options.bundlePath);
  const commits = await newCommits(git, head, historyBase, remoteTips);
  const messages = new Map<string, ParsedCommit>();
  for (const commit of commits) messages.set(commit.sha, await readCommit(git, commit.sha));
  const tip = await rewrite(git, head, commits, messages, historyBase, remoteTips);
  const changes = await agentChanges(git, commits, options);
  return { tip, ...changes };
}

/**
 * Step 1: a strict header naming exactly one head, RESULT_BUNDLE_HEAD_REF; every object of its pack
 * checked with `index-pack --strict` (git's object checks, which a fetch from a bundle skips on older
 * git whatever fetch.fsckObjects says); then the fetch, its own checks kept.
 */
async function fetchBundle(git: ResultGit, bundlePath: string): Promise<string> {
  // The collector moved it here; still never followed as a symlink.
  const stat = await lstat(bundlePath).catch(() => null);
  if (!stat || !stat.isFile()) fail("vcs_result_bundle_invalid");
  let handle: FileHandle | undefined;
  try {
    handle = await open(bundlePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    fail("vcs_result_bundle_invalid");
  }
  let sha: string;
  try {
    const header = await readBundleHeader(handle);
    sha = header.head;
    // git's own reading of the header must agree with ours.
    const listed = await step("vcs_result_bundle_invalid", () =>
      git(["bundle", "list-heads", bundlePath], {
        maxOutputBytes: LIST_HEADS_MAX_BYTES,
        timeoutMs: GIT_STEP_TIMEOUT_MS,
      }),
    );
    if (listed.stdout !== `${sha} ${RESULT_BUNDLE_HEAD_REF}\n`) fail("vcs_result_bundle_invalid");
    await verifyPack(git, bundlePath, handle, header.packOffset);
  } finally {
    await handle.close().catch(() => undefined);
  }
  await step("vcs_result_bundle_invalid", () =>
    git(
      [
        "-c",
        "transfer.fsckObjects=true",
        "-c",
        "fetch.fsckObjects=true",
        // A bundle is read by path; nothing else may be fetched.
        "-c",
        "protocol.file.allow=always",
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        "--no-recurse-submodules",
        "--quiet",
        bundlePath,
        `+${sha}:${RESULT_RAW_REF}`,
      ],
      { timeoutMs: BUNDLE_FETCH_TIMEOUT_MS },
    ),
  );
  const fetched = await step("vcs_result_bundle_invalid", () =>
    git(["rev-parse", "--verify", `${RESULT_RAW_REF}^{commit}`], { timeoutMs: GIT_STEP_TIMEOUT_MS }),
  );
  if (fetched.stdout.trim() !== sha) fail("vcs_result_bundle_invalid");
  return sha;
}

interface BundleHeader {
  head: string;
  /** Where the pack starts: the byte after the header's blank line. */
  packOffset: number;
}

/**
 * The bundle's header, read strictly (git's bundle format, v2 or v3): the signature; for v3 only the
 * capability `@object-format=sha1`, at most once and first; prerequisite lines `-<sha>[ <comment>]`;
 * exactly one ref line, `<sha> refs/wardby/bundle-head`; a blank line; then a pack (`PACK`). Anything
 * else, or a header over BUNDLE_HEADER_MAX_BYTES, raises vcs_result_bundle_invalid.
 */
async function readBundleHeader(handle: FileHandle): Promise<BundleHeader> {
  const buffer = Buffer.alloc(BUNDLE_HEADER_MAX_BYTES + 4);
  let length = 0;
  try {
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
  } catch {
    fail("vcs_result_bundle_invalid");
  }
  const bytes = buffer.subarray(0, length);
  const blank = bytes.indexOf("\n\n");
  if (blank < 0 || blank + 1 > BUNDLE_HEADER_MAX_BYTES) fail("vcs_result_bundle_invalid");
  const packOffset = blank + 2;
  if (bytes.subarray(packOffset, packOffset + 4).toString("latin1") !== "PACK") fail("vcs_result_bundle_invalid");
  const [signature, ...lines] = bytes.subarray(0, blank).toString("latin1").split("\n");
  const version =
    signature === "# v2 git bundle" ? 2 : signature === "# v3 git bundle" ? 3 : fail("vcs_result_bundle_invalid");
  // 0: capabilities (v3), 1: prerequisites, 2: the ref.
  let section = version === 3 ? 0 : 1;
  let capabilities = 0;
  let prerequisites = 0;
  let head: string | undefined;
  for (const line of lines) {
    if (line.startsWith("@")) {
      if (section !== 0 || line !== "@object-format=sha1" || capabilities > 0) fail("vcs_result_bundle_invalid");
      capabilities += 1;
    } else if (line.startsWith("-")) {
      if (section > 1 || !/^-[0-9a-f]{40}(?: [^\0]*)?$/.test(line)) fail("vcs_result_bundle_invalid");
      section = 1;
      prerequisites += 1;
      if (prerequisites > BUNDLE_PREREQUISITES_MAX) fail("vcs_result_bundle_invalid");
    } else {
      const ref = /^([0-9a-f]{40}) (\S+)$/.exec(line);
      if (!ref || head !== undefined || ref[2] !== RESULT_BUNDLE_HEAD_REF) fail("vcs_result_bundle_invalid");
      section = 2;
      head = ref[1];
    }
  }
  if (head === undefined || !COMMIT_SHA.test(head)) fail("vcs_result_bundle_invalid");
  return { head, packOffset };
}

/**
 * Runs the bundle's pack through `index-pack --strict --fix-thin --stdin` into a quarantine directory
 * beside the bundle (an explicit pack path, so the control plane's object store is only read, for the
 * thin pack's bases, never written). A malformed object fails here with nothing imported; the
 * quarantine is removed either way and the fetch then imports the same, checked pack.
 */
async function verifyPack(git: ResultGit, bundlePath: string, handle: FileHandle, packOffset: number): Promise<void> {
  let quarantine: string;
  try {
    quarantine = await mkdtemp(join(dirname(bundlePath), ".wardby-verify-"));
  } catch {
    fail("vcs_result_bundle_invalid");
  }
  try {
    const pack = handle.createReadStream({ start: packOffset, autoClose: false });
    await step("vcs_result_bundle_invalid", () =>
      git(["index-pack", "--strict", "--fix-thin", "--stdin", join(quarantine, "result.pack")], {
        input: pack,
        maxOutputBytes: INDEX_PACK_MAX_BYTES,
        timeoutMs: BUNDLE_FETCH_TIMEOUT_MS,
      }),
    );
  } finally {
    await rm(quarantine, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Step 2: the new commits, oldest first; each parent is another new commit, the history base or a fetched tip. */
async function newCommits(
  git: ResultGit,
  head: string,
  historyBase: string,
  remoteTips: readonly string[],
): Promise<NewCommit[]> {
  await step("vcs_result_history_invalid", () =>
    git(["merge-base", "--is-ancestor", historyBase, head], { timeoutMs: GIT_STEP_TIMEOUT_MS }),
  );
  const listed = await step("vcs_result_history_invalid", () =>
    git(
      [
        "rev-list",
        `--max-count=${MAX_RESULT_COMMITS + 1}`,
        "--topo-order",
        "--parents",
        head,
        "--not",
        historyBase,
        ...remoteTips,
      ],
      { timeoutMs: GIT_STEP_TIMEOUT_MS },
    ),
  );
  const lines = listed.stdout.split("\n").filter((line) => line !== "");
  if (lines.length > MAX_RESULT_COMMITS) fail("vcs_result_commit_limit");
  if (lines.length === 0) {
    // A fast-forward onto a fetched remote tip (historyBase is its ancestor, checked above): the tip
    // is the result as it is, every commit in it upstream's, none the agent's.
    if (remoteTips.includes(head)) return [];
    fail("vcs_result_history_invalid");
  }
  // Newest first from rev-list (--max-count applies before --reverse would), so reversed here.
  const commits = lines.reverse().map((line): NewCommit => {
    const [sha, ...parents] = line.split(" ");
    if (!COMMIT_SHA.test(sha) || parents.some((parent) => !COMMIT_SHA.test(parent))) {
      fail("vcs_result_history_invalid");
    }
    return { sha, parents };
  });
  if (commits.at(-1)?.sha !== head) fail("vcs_result_history_invalid");
  const allowed = new Set([historyBase, ...remoteTips]);
  const seen = new Set<string>();
  for (const commit of commits) {
    // A root commit brings in history that is neither the run's nor a fetched remote's.
    if (commit.parents.length === 0) fail("vcs_result_history_invalid");
    for (const parent of commit.parents) {
      if (!seen.has(parent) && !allowed.has(parent)) fail("vcs_result_history_invalid");
    }
    seen.add(commit.sha);
  }
  return commits;
}

interface ParsedCommit {
  tree: string;
  message: string;
  authorDate: string;
  committerDate: string;
}

/** Step 3: a commit's tree, message and dates; the message and both identities carry no token-shaped value. */
async function readCommit(git: ResultGit, sha: string): Promise<ParsedCommit> {
  let raw: string;
  try {
    raw = (
      await git(["cat-file", "commit", sha], {
        maxOutputBytes: COMMIT_OBJECT_MAX_BYTES,
        timeoutMs: GIT_STEP_TIMEOUT_MS,
      })
    ).stdout;
  } catch (error) {
    if (isOutputLimit(error)) fail("vcs_result_commit_unsafe");
    fail("vcs_result_history_invalid");
  }
  const split = raw.indexOf("\n\n");
  const header = (split < 0 ? raw : raw.slice(0, split)).split("\n");
  const message = split < 0 ? "" : raw.slice(split + 2);
  if (Buffer.byteLength(message, "utf8") > MAX_RESULT_MESSAGE_BYTES) fail("vcs_result_commit_unsafe");
  const field = (name: string) => header.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1);
  const tree = field("tree");
  const author = field("author");
  const committer = field("committer");
  if (!tree || !COMMIT_SHA.test(tree) || author === undefined || committer === undefined) {
    fail("vcs_result_history_invalid");
  }
  for (const text of [message, author, committer]) {
    if (redactSecrets(text, []) !== text) fail("vcs_result_commit_unsafe");
  }
  const authorDate = AUTHOR_DATE.exec(author);
  const committerDate = AUTHOR_DATE.exec(committer);
  if (!authorDate || !committerDate) fail("vcs_result_history_invalid");
  return {
    tree,
    message,
    authorDate: `@${authorDate[1]} ${authorDate[2]}`,
    committerDate: `@${committerDate[1]} ${committerDate[2]}`,
  };
}

/**
 * Step 4: each new commit again, oldest first, with commit-tree: its tree and message, its parents
 * mapped, Wardby as author and committer, its own author and committer dates (so importing the same
 * bundle twice gives the same commits). Signatures and other headers are dropped.
 */
async function rewrite(
  git: ResultGit,
  head: string,
  commits: readonly NewCommit[],
  parsed: ReadonlyMap<string, ParsedCommit>,
  historyBase: string,
  remoteTips: readonly string[],
): Promise<string> {
  const mapped = new Map<string, string>([[historyBase, historyBase], ...remoteTips.map((tip) => [tip, tip] as const)]);
  // No new commits: a fast-forward onto a remote tip, which is kept as it is.
  let tip = head;
  for (const commit of commits) {
    const { tree, message, authorDate, committerDate } = parsed.get(commit.sha)!;
    const parents = commit.parents.flatMap((parent) => ["-p", mapped.get(parent)!]);
    const rewritten = (
      await step("vcs_result_history_invalid", () =>
        git(["commit-tree", tree, ...parents, "-F", "-"], {
          input: message,
          timeoutMs: GIT_STEP_TIMEOUT_MS,
          env: {
            GIT_AUTHOR_NAME: WARDBY_IDENTITY.name,
            GIT_AUTHOR_EMAIL: WARDBY_IDENTITY.email,
            GIT_AUTHOR_DATE: authorDate,
            GIT_COMMITTER_NAME: WARDBY_IDENTITY.name,
            GIT_COMMITTER_EMAIL: WARDBY_IDENTITY.email,
            GIT_COMMITTER_DATE: committerDate,
          },
        }),
      )
    ).stdout.trim();
    if (!COMMIT_SHA.test(rewritten)) fail("vcs_result_history_invalid");
    mapped.set(commit.sha, rewritten);
    tip = rewritten;
  }
  await step("vcs_result_history_invalid", () =>
    git(["update-ref", RESULT_REWRITTEN_REF, tip], { timeoutMs: GIT_STEP_TIMEOUT_MS }),
  );
  return tip;
}

interface RawChange {
  mode: string;
  object: string;
  path: string;
}

/**
 * `diff-tree -r -z --raw` output, per change: `:<old mode> <new mode> <old sha> <new sha> <status>\0<path>\0`
 * for one parent; for a merge's combined diff (-c) with N parents, N colons, N + 1 modes, N + 1 shas
 * and N status letters. The new entry (the last mode and sha) is kept.
 */
function parseRaw(output: string, parents: number): RawChange[] {
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 2 !== 0) fail("vcs_result_history_invalid");
  const meta =
    parents > 1
      ? new RegExp(
          `^:{${parents}}(?:\\d{6} ){${parents}}(\\d{6}) (?:[0-9a-f]{40} ){${parents}}([0-9a-f]{40}) [A-Z]{${parents}}$`,
        )
      : /^:\d{6} (\d{6}) [0-9a-f]{40} ([0-9a-f]{40}) [A-Z]\d*$/;
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const entry = meta.exec(fields[index]);
    if (!entry) fail("vcs_result_history_invalid");
    changes.push({ mode: entry[1], object: entry[2], path: validateChangedPath(fields[index + 1]) });
  }
  return changes;
}

/**
 * Step 5: the paths where each new commit's tree differs from every parent (for a merge, its
 * combined diff: a path a merge took unchanged from some parent is that parent's),
 * and the bytes of each commit's own diff. Each such path is checked the way a collected workspace
 * is: no `.git` part, no submodule, no symlink out of the repository.
 */
async function agentChanges(
  git: ResultGit,
  commits: readonly NewCommit[],
  options: ImportResultBundleOptions,
): Promise<Omit<ImportedHistory, "tip">> {
  const agentPaths = new Set<string>();
  const mergePaths = new Set<string>();
  let agentDiffBytes = 0;
  for (const commit of commits) {
    // One parent: its plain diff. A merge: the combined diff (-c), which lists only the paths that
    // differ from every parent, so its size is the agent's resolutions, never upstream's change set.
    const merge = commit.parents.length > 1;
    const listed = await gitLimited(
      () =>
        git(
          merge
            ? ["diff-tree", "-c", "-r", "-z", "--raw", "--no-commit-id", commit.sha]
            : ["diff-tree", "-r", "-z", "--raw", "--no-renames", "--no-commit-id", commit.parents[0], commit.sha],
          { maxOutputBytes: NAME_LIST_MAX_BYTES, timeoutMs: GIT_STEP_TIMEOUT_MS },
        ),
      "vcs_changed_file_limit",
    );
    const own = new Map(parseRaw(listed.stdout, commit.parents.length).map((change) => [change.path, change]));
    for (const change of own.values()) {
      await checkEntry(git, change);
      agentPaths.add(change.path);
      if (commit.parents.length > 1) mergePaths.add(change.path);
    }
    if (agentPaths.size > options.maxChangedFiles) fail("vcs_changed_file_limit");
    if (own.size === 0) continue;
    const remaining = options.maxDiffBytes - agentDiffBytes;
    const diffArgs =
      commit.parents.length > 1
        ? ["diff-tree", "--cc", "-p", "--no-commit-id", "--no-ext-diff", "--no-textconv", commit.sha]
        : [
            "diff-tree",
            "-r",
            "-p",
            "--binary",
            "--no-renames",
            "--no-commit-id",
            "--no-ext-diff",
            "--no-textconv",
            commit.parents[0],
            commit.sha,
          ];
    const diff = await gitLimited(
      () => git(diffArgs, { maxOutputBytes: Math.max(remaining, 0) + 1, timeoutMs: GIT_STEP_TIMEOUT_MS }),
      "vcs_diff_size_limit",
    );
    agentDiffBytes += Buffer.byteLength(diff.stdout, "utf8");
    if (agentDiffBytes > options.maxDiffBytes) fail("vcs_diff_size_limit");
  }
  return { agentPaths: [...agentPaths], agentDiffBytes, mergePaths: [...mergePaths] };
}

async function gitLimited(action: () => Promise<{ stdout: string }>, limitCode: string): Promise<{ stdout: string }> {
  try {
    return await action();
  } catch (error) {
    if (isOutputLimit(error)) fail(limitCode);
    fail("vcs_result_history_invalid");
  }
}

/** One agent path's new entry: no `.git` part, no submodule, and a symlink only to somewhere inside the repository. */
async function checkEntry(git: ResultGit, change: RawChange): Promise<void> {
  if (change.path.split("/").some((part) => part.toLowerCase() === ".git")) fail("vcs_nested_repository");
  if (change.mode === GITLINK_MODE) fail("vcs_nested_repository");
  if (change.mode !== SYMLINK_MODE) return;
  const target = (
    await gitLimited(
      () =>
        git(["cat-file", "blob", change.object], {
          maxOutputBytes: SYMLINK_TARGET_MAX_BYTES,
          timeoutMs: GIT_STEP_TIMEOUT_MS,
        }),
      "vcs_symlink_escape",
    )
  ).stdout;
  const resolved = posix.normalize(posix.join(posix.dirname(change.path), target));
  if (!target || target.includes("\0") || posix.isAbsolute(target) || resolved === ".." || resolved.startsWith("../")) {
    fail("vcs_symlink_escape");
  }
}
