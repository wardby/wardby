// TEST ONLY (wardby-sim). The simulated repositories' content: one real bare git repository
// per simulated repo, so diffs, compares, merge-tree and conflicts are git's own. Every
// REST answer about content (pull request files, compare, contents, trees) is read from here.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BUFFER = 512 * 1024 * 1024;

export interface ChangedFile {
  sha: string | null;
  filename: string;
  status: "added" | "removed" | "modified" | "renamed";
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  previous_filename?: string;
}

export interface CommitInfo {
  sha: string;
  parents: string[];
  message: string;
  authorName: string;
  authorEmail: string;
  date: string;
  tree: string;
}

export interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  mode: string;
  sha: string;
  size?: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
  }
}

/** git >= 2.38 is needed for `merge-tree --write-tree` (and by wardby's own merge-order checks). */
export async function gitVersionOk(): Promise<boolean> {
  const out = await runGit(process.cwd(), ["--version"]).catch(() => "");
  const match = /git version (\d+)\.(\d+)/.exec(out);
  return !!match && (Number(match[1]) > 2 || (Number(match[1]) === 2 && Number(match[2]) >= 38));
}

function gitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    ...extra,
  };
}

export function runGit(
  cwd: string,
  args: string[],
  options: { input?: string | Buffer; env?: Record<string, string> } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      args,
      { cwd, env: gitEnv(options.env), maxBuffer: MAX_BUFFER, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) reject(new GitError(`git ${args[0]} failed`, String(stderr)));
        else resolve(String(stdout));
      },
    );
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
}

export class GitStore {
  readonly root: string;
  private readonly ownsRoot: boolean;

  constructor(root?: string) {
    this.ownsRoot = !root;
    this.root = root ?? mkdtempSync(join(tmpdir(), "wardby-sim-git-"));
    mkdirSync(this.root, { recursive: true });
  }

  dir(fullName: string): string {
    return join(this.root, `${fullName.toLowerCase()}.git`);
  }

  async create(fullName: string, defaultBranch: string): Promise<void> {
    const dir = this.dir(fullName);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    await runGit(dir, ["init", "--bare", "--quiet", `--initial-branch=${defaultBranch}`]);
    // Served over smart HTTP: allow pushes and keep the reflog out of the way.
    await runGit(dir, ["config", "http.receivepack", "true"]);
    await runGit(dir, ["config", "uploadpack.allowReachableSHA1InWant", "true"]);
  }

  remove(fullName: string): void {
    rmSync(this.dir(fullName), { recursive: true, force: true });
  }

  /** Removes every repository (a scenario reset). */
  clear(): void {
    rmSync(this.root, { recursive: true, force: true });
    mkdirSync(this.root, { recursive: true });
  }

  dispose(): void {
    if (this.ownsRoot) rmSync(this.root, { recursive: true, force: true });
  }

  async resolve(fullName: string, ref: string): Promise<string | null> {
    if (ref.startsWith("-")) return null;
    try {
      return (await runGit(this.dir(fullName), ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim() || null;
    } catch {
      return null;
    }
  }

  async branches(fullName: string): Promise<Map<string, string>> {
    const out = await runGit(this.dir(fullName), [
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      "refs/heads",
    ]);
    const map = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
      const [name, sha] = line.split(" ");
      map.set(name, sha);
    }
    return map;
  }

  async setBranch(fullName: string, branch: string, sha: string, expectedOld?: string | null): Promise<void> {
    const args = ["update-ref", `refs/heads/${branch}`, sha];
    if (expectedOld !== undefined) args.push(expectedOld ?? "0000000000000000000000000000000000000000");
    await runGit(this.dir(fullName), args);
  }

  async deleteBranch(fullName: string, branch: string): Promise<void> {
    await runGit(this.dir(fullName), ["update-ref", "-d", `refs/heads/${branch}`]);
  }

  /**
   * Writes a commit on `branch` changing `files` (a null value deletes the path) on top of the
   * branch's head (or `parent`, or no parent for the first commit), and moves the branch.
   */
  async commit(
    fullName: string,
    input: {
      branch: string;
      files: Record<string, string | null>;
      message: string;
      parent?: string | null;
      extraParents?: string[];
      author?: { name: string; email: string };
      date?: string;
    },
  ): Promise<string> {
    const dir = this.dir(fullName);
    const current = await this.resolve(fullName, `refs/heads/${input.branch}`);
    const parent = input.parent !== undefined ? input.parent : current;
    const scratch = mkdtempSync(join(tmpdir(), "wardby-sim-index-"));
    const env = { GIT_INDEX_FILE: join(scratch, "index") };
    try {
      if (parent) await runGit(dir, ["read-tree", parent], { env });
      else await runGit(dir, ["read-tree", "--empty"], { env });
      const additions = Object.entries(input.files).filter(([, content]) => content !== null);
      const removals = Object.entries(input.files).filter(([, content]) => content === null);
      const lines: string[] = [];
      for (const [path, content] of additions) {
        const blob = (await runGit(dir, ["hash-object", "-w", "--stdin"], { input: content! })).trim();
        lines.push(`100644 ${blob}\t${path}`);
      }
      for (const [path] of removals) lines.push(`0 ${"0".repeat(40)}\t${path}`);
      if (lines.length > 0)
        await runGit(dir, ["update-index", "--index-info"], { input: `${lines.join("\n")}\n`, env });
      const tree = (await runGit(dir, ["write-tree"], { env })).trim();
      const parents = [...(parent ? [parent] : []), ...(input.extraParents ?? [])];
      return await this.commitTree(
        fullName,
        tree,
        parents,
        input.message,
        input.branch,
        current,
        input.author,
        input.date,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async commitTree(
    fullName: string,
    tree: string,
    parents: string[],
    message: string,
    branch: string | null,
    expectedOld: string | null | undefined,
    author: { name: string; email: string } = { name: "Sim User", email: "sim@example.invalid" },
    date = new Date().toISOString(),
  ): Promise<string> {
    const env = {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: author.name,
      GIT_COMMITTER_EMAIL: author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    const args = ["commit-tree", tree, ...parents.flatMap((p) => ["-p", p])];
    const sha = (await runGit(this.dir(fullName), args, { input: message, env })).trim();
    if (branch) await this.setBranch(fullName, branch, sha, expectedOld);
    return sha;
  }

  async commitInfo(fullName: string, sha: string): Promise<CommitInfo | null> {
    try {
      const out = await runGit(this.dir(fullName), [
        "show",
        "-s",
        "--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%T%x00%B",
        sha,
      ]);
      const [hash, parents, authorName, authorEmail, date, tree, ...message] = out.split("\0");
      return {
        sha: hash,
        parents: parents.split(" ").filter(Boolean),
        authorName,
        authorEmail,
        date,
        tree,
        message: message.join("\0").replace(/\n+$/, ""),
      };
    } catch {
      return null;
    }
  }

  async isAncestor(fullName: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await runGit(this.dir(fullName), ["merge-base", "--is-ancestor", ancestor, descendant]);
      return true;
    } catch {
      return false;
    }
  }

  async mergeBase(fullName: string, a: string, b: string): Promise<string | null> {
    try {
      return (await runGit(this.dir(fullName), ["merge-base", a, b])).trim() || null;
    } catch {
      return null;
    }
  }

  /** Commits reachable from `to` and not from `from`, oldest first. */
  async commitsBetween(fullName: string, from: string, to: string): Promise<CommitInfo[]> {
    const out = await runGit(this.dir(fullName), ["rev-list", "--reverse", `${from}..${to}`]);
    const shas = out.split("\n").filter(Boolean);
    const infos: CommitInfo[] = [];
    for (const sha of shas) {
      const info = await this.commitInfo(fullName, sha);
      if (info) infos.push(info);
    }
    return infos;
  }

  async countBetween(fullName: string, from: string, to: string): Promise<number> {
    return Number((await runGit(this.dir(fullName), ["rev-list", "--count", `${from}..${to}`])).trim());
  }

  /** The files changed from `from` to `to` (a two-point diff), with GitHub-shaped fields. */
  async diff(fullName: string, from: string, to: string): Promise<ChangedFile[]> {
    const dir = this.dir(fullName);
    const raw = await runGit(dir, ["diff", "--raw", "-z", "--no-abbrev", "-M", "--numstat", from, to]);
    const parts = raw.split("\0");
    const files: ChangedFile[] = [];
    // --raw entries come first (":old new oldsha newsha status\0path[\0path2]"), then numstat.
    let i = 0;
    const raws: { status: string; sha: string; path: string; previous?: string }[] = [];
    while (i < parts.length && parts[i].startsWith(":")) {
      const meta = parts[i].split(" ");
      const status = meta[4];
      const sha = meta[3];
      if (status.startsWith("R") || status.startsWith("C")) {
        raws.push({ status: status[0], sha, previous: parts[i + 1], path: parts[i + 2] });
        i += 3;
      } else {
        raws.push({ status, sha, path: parts[i + 1] });
        i += 2;
      }
    }
    const stats = new Map<string, { additions: number; deletions: number }>();
    // numstat -z: "add\tdel\tpath\0" or for renames "add\tdel\t\0old\0new\0".
    while (i < parts.length) {
      const entry = parts[i];
      if (!entry) {
        i += 1;
        continue;
      }
      const [add, del, path] = entry.split("\t");
      if (path === "") {
        stats.set(parts[i + 2], { additions: Number(add) || 0, deletions: Number(del) || 0 });
        i += 3;
      } else {
        stats.set(path, { additions: Number(add) || 0, deletions: Number(del) || 0 });
        i += 1;
      }
    }
    const patches = splitPatches(await runGit(dir, ["diff", "-M", "--no-color", "--no-ext-diff", from, to]));
    for (const entry of raws) {
      const stat = stats.get(entry.path) ?? { additions: 0, deletions: 0 };
      const status =
        entry.status === "A"
          ? "added"
          : entry.status === "D"
            ? "removed"
            : entry.status === "R"
              ? "renamed"
              : "modified";
      const patch = patches.get(entry.path);
      files.push({
        sha: status === "removed" ? null : entry.sha,
        filename: entry.path,
        status,
        additions: stat.additions,
        deletions: stat.deletions,
        changes: stat.additions + stat.deletions,
        ...(patch !== undefined ? { patch } : {}),
        ...(entry.previous ? { previous_filename: entry.previous } : {}),
      });
    }
    return files;
  }

  /** A blob's content, or a directory's entries, at `ref`; null when the path is absent. */
  async read(
    fullName: string,
    ref: string,
    path: string,
  ): Promise<{ kind: "file"; content: Buffer; sha: string } | { kind: "dir"; entries: TreeEntry[] } | null> {
    const dir = this.dir(fullName);
    const commit = await this.resolve(fullName, ref);
    if (!commit) return null;
    const spec = path === "" ? `${commit}^{tree}` : `${commit}:${path}`;
    let type: string;
    try {
      type = (await runGit(dir, ["cat-file", "-t", spec])).trim();
    } catch {
      return null;
    }
    if (type === "tree") {
      const entries = await this.lsTree(fullName, spec, false);
      return { kind: "dir", entries: entries.map((e) => ({ ...e, path: path ? `${path}/${e.path}` : e.path })) };
    }
    const sha = (await runGit(dir, ["rev-parse", spec])).trim();
    const content = await new Promise<Buffer>((resolve, reject) => {
      execFile(
        "git",
        ["cat-file", "blob", sha],
        { cwd: dir, env: gitEnv(), maxBuffer: MAX_BUFFER, encoding: "buffer" },
        (error, stdout) => (error ? reject(new GitError("git cat-file failed", "")) : resolve(stdout)),
      );
    });
    return { kind: "file", content, sha };
  }

  async lsTree(fullName: string, treeish: string, recursive: boolean): Promise<TreeEntry[]> {
    const args = ["ls-tree", "-l", "-z", ...(recursive ? ["-r", "-t"] : []), treeish];
    const out = await runGit(this.dir(fullName), args);
    return out
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const [meta, path] = line.split("\t");
        const [mode, type, sha, size] = meta.split(/\s+/);
        return {
          path,
          mode,
          type: type === "tree" ? "tree" : "blob",
          sha,
          ...(size && size !== "-" ? { size: Number(size) } : {}),
        };
      });
  }

  /**
   * Merges `head` into `base` the way GitHub's merge button does: a merge commit (two parents)
   * or a squash (one parent, the merged tree). Null on a conflict.
   */
  async mergeTree(fullName: string, base: string, head: string): Promise<string | null> {
    try {
      const out = await runGit(this.dir(fullName), ["merge-tree", "--write-tree", "--no-messages", base, head]);
      return out.split("\n")[0].trim() || null;
    } catch {
      return null;
    }
  }
}

/** Splits a multi-file `git diff` into each file's hunks (GitHub's `patch`: from the first @@). */
function splitPatches(diff: string): Map<string, string> {
  const map = new Map<string, string>();
  const sections = diff.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const lines = section.split("\n");
    let minus: string | undefined;
    let plus: string | undefined;
    for (const line of lines) {
      if (line.startsWith("--- a/")) minus = line.slice(6);
      else if (line.startsWith("+++ b/")) plus = line.slice(6);
      if (line.startsWith("@@")) break;
    }
    const header = /^a\/(.+?) b\/(.+)$/.exec(lines[0]);
    const path = plus ?? minus ?? header?.[2];
    const hunkStart = section.indexOf("\n@@");
    if (!path) continue;
    if (hunkStart === -1) continue;
    map.set(path, section.slice(hunkStart + 1).replace(/\n$/, ""));
  }
  return map;
}
