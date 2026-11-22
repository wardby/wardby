/**
 * The quickstart's optional coding step: trust local folders, start the coding
 * proxy, and seed a coding agent (`local-builder`) and a review agent
 * (`local-reviewer`) against a local git repository — no GitHub App needed.
 *
 * Every Docker/Compose call, prompt, and database write goes through
 * CodingDeps so tests never touch the Docker daemon. The only write into the
 * user's repository is the opt-in starter `.wardby/services.yaml`, made with
 * git plumbing onto its own branch (starter-services.ts).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { delimiter, join, resolve, sep } from "node:path";

import { dockerCodingPreflight } from "../coding/docker-preflight.js";
import { cleanGitEnv } from "../coding/local-git.js";
import { LOCAL_REPO_PREFIX, loadLocalRepoRoots, resolveLocalRepository } from "../coding/local-repo.js";
import type { CodingProvider } from "../coding/provider.js";
import type { DeclaredService } from "../coding/services/declaration.js";
import { BUILDER_AGENT, REVIEWER_AGENT, type CodingSeedInput, type CodingSeedResult } from "./coding-seed.js";
import {
  defaultModel,
  defaultReviewerModel,
  readQuickstartEnv,
  writeQuickstartEnv,
  type QuickstartPaths,
  type QuickstartState,
} from "./config.js";
import { CodingSkip, NODE_PYTHON_ENV, prepareImages, prepareNodePythonImage } from "./coding-images.js";
import { detectPythonProject } from "./python-detect.js";
import { readRepoPackages } from "./repo-packages.js";
import {
  STARTER_SERVICES_BRANCH,
  commitStarterServices,
  declaredServicesLabel,
  inspectDeclaredServices,
  repoDefaultBranch,
  starterDeclaredServices,
  starterServicesYaml,
  type StarterService,
} from "./starter-services.js";

export const CODING_PROXY_CONTAINER = "wardby-coding-proxy";
export const CODING_COMPOSE_FILE = "deploy/local/docker-compose.quickstart-coding.yml";
const BASE_COMPOSE_FILE = "deploy/local/docker-compose.yml";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; inherit?: boolean },
) => CommandResult;

export interface CodingPrompts {
  line(question: string, fallback?: string): Promise<string>;
  yesNo(question: string, defaultYes: boolean): Promise<boolean>;
  secret(question: string): Promise<string>;
}

export interface CodingDeps {
  run: RunCommand;
  prompts: CodingPrompts;
  log: (line: string) => void;
  cwd: string;
  /** The process environment: provider keys and image overrides. */
  env: NodeJS.ProcessEnv;
  packageRoot: string;
  seed: (input: Omit<CodingSeedInput, "ownerId">) => Promise<CodingSeedResult>;
  /** The catalog image for each declared service; `image` is undefined when the catalog has no such entry. */
  catalogImages: (services: DeclaredService[]) => Promise<Array<{ service: DeclaredService; image?: string }>>;
}

export interface CodingStepOptions {
  nonInteractive: boolean;
  /** true = --coding, false = --no-coding, undefined = ask (interactive) or skip (non-interactive). */
  coding?: boolean;
  trust: string[];
  provider?: CodingProvider;
  /** --starter-services; undefined = ask (interactive) or none (non-interactive). */
  starterServices?: StarterService[];
  /** --allow-repo-packages / --no-allow-repo-packages; undefined = ask (interactive) or none (non-interactive). */
  allowRepoPackages?: boolean;
}

export interface CodingStepResult {
  roots: string[];
  provider: CodingProvider;
  repository?: string;
  seed?: CodingSeedResult;
}

const PROVIDER_KEYS: Record<CodingProvider, "OPENAI_API_KEY" | "ANTHROPIC_API_KEY"> = {
  codex: "OPENAI_API_KEY",
  "claude-code": "ANTHROPIC_API_KEY",
};
const PROVIDER_LABELS: Record<CodingProvider, string> = { codex: "Codex", "claude-code": "Claude Code" };

/** The top level of the git work tree containing `cwd`, realpath'd; null outside one. */
export function defaultTrustedFolder(cwd: string): string | null {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, "rev-parse", "--show-toplevel"],
    { encoding: "utf8", env: cleanGitEnv() },
  );
  const top = result.status === 0 ? result.stdout.trim() : "";
  if (!top) return null;
  try {
    return realpathSync(top);
  } catch {
    return null;
  }
}

export function codingEnvUpdates(input: {
  roots: string[];
  provider: string;
  /** The Codex worker; absent for claude-code, which doesn't need one. */
  workerImage?: string;
  runtimeImage: string;
  claudeWorkerImage?: string;
  claudeToolRunnerImage?: string;
}): Record<string, string> {
  const updates: Record<string, string> = {
    LOCAL_REPO_ROOTS: input.roots.join(delimiter),
    JOB_LAUNCHER: "docker",
    WARDBY_RUNTIME_IMAGE: input.runtimeImage,
    CODING_PROXY_CONTAINER,
  };
  if (input.provider !== "claude-code" && input.workerImage) updates.CODING_WORKER_IMAGE = input.workerImage;
  if (input.provider === "claude-code" && input.claudeWorkerImage && input.claudeToolRunnerImage) {
    updates.CODING_CLAUDE_WORKER_IMAGE = input.claudeWorkerImage;
    updates.CODING_CLAUDE_TOOL_RUNNER_IMAGE = input.claudeToolRunnerImage;
  }
  return updates;
}

/** The compose files for a quickstart project; the coding file only once its runtime image is configured. */
export function quickstartComposeFiles(packageRoot: string, env: Record<string, string | undefined>): string[] {
  const files = [join(packageRoot, BASE_COMPOSE_FILE)];
  if (env.WARDBY_RUNTIME_IMAGE) files.push(join(packageRoot, CODING_COMPOSE_FILE));
  return files;
}

function realFolder(path: string): string {
  let real: string;
  try {
    real = realpathSync(resolve(path));
  } catch {
    throw new CodingSkip(`${path} does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new CodingSkip(`${path} is not a folder`);
  return real;
}

async function isRepositoryTop(path: string, roots: string[]): Promise<boolean> {
  try {
    await resolveLocalRepository(`${LOCAL_REPO_PREFIX}${path}`, roots);
    return true;
  } catch {
    return false;
  }
}

async function chooseRoots(opts: CodingStepOptions, existing: string[], deps: CodingDeps): Promise<string[]> {
  const roots = [...existing];
  const add = (path: string) => {
    const real = realFolder(path);
    if (!roots.includes(real)) roots.push(real);
  };
  for (const path of opts.trust) add(path);
  if (opts.nonInteractive) {
    if (roots.length === 0) throw new CodingSkip("pass --trust <dir> to choose the folders coding agents may use");
    return roots;
  }

  if (existing.length > 0) {
    deps.log("Trusted folders:");
    existing.forEach((root, index) => deps.log(`  [${index + 1}] ${root}`));
    const remove = await deps.prompts.line("Remove any? Numbers separated by commas (blank = keep all): ", "");
    const drop = new Set(remove.split(",").map((part) => Number(part.trim()) - 1));
    for (const index of [...drop].sort((a, b) => b - a)) {
      if (Number.isInteger(index) && index >= 0 && index < existing.length)
        roots.splice(roots.indexOf(existing[index]), 1);
    }
  }
  const suggested = defaultTrustedFolder(deps.cwd);
  if (suggested && !roots.includes(suggested) && (await deps.prompts.yesNo(`Trust ${suggested}?`, true))) {
    roots.push(suggested);
  }
  for (;;) {
    const answer = await deps.prompts.line("Add another trusted folder (blank = done): ", "");
    if (!answer) break;
    try {
      add(answer);
    } catch (error) {
      deps.log(`! ${(error as Error).message}`);
    }
  }
  if (roots.length === 0) throw new CodingSkip("no folder was trusted");
  return roots;
}

async function chooseProvider(
  opts: CodingStepOptions,
  config: Record<string, string>,
  deps: CodingDeps,
): Promise<CodingProvider> {
  const hasKey = (provider: CodingProvider) =>
    Boolean(deps.env[PROVIDER_KEYS[provider]] || config[PROVIDER_KEYS[provider]]);
  let provider = opts.provider;
  if (!provider) {
    const available = (["codex", "claude-code"] as const).filter(hasKey);
    if (available.length === 1 || (opts.nonInteractive && available.length > 0)) provider = available[0];
    else if (opts.nonInteractive) throw new CodingSkip("set OPENAI_API_KEY (Codex) or ANTHROPIC_API_KEY (Claude Code)");
    else {
      const answer = (await deps.prompts.line("Coding agent: [1] Codex, [2] Claude Code [1] ", "1")).toLowerCase();
      if (answer === "1" || answer === "codex") provider = "codex";
      else if (answer === "2" || answer === "claude-code" || answer === "claude") provider = "claude-code";
      else throw new CodingSkip(`unknown coding agent "${answer}"`);
    }
  }
  const keyName = PROVIDER_KEYS[provider];
  if (!hasKey(provider)) {
    if (opts.nonInteractive) throw new CodingSkip(`${keyName} is required for ${PROVIDER_LABELS[provider]}`);
    const key = await deps.prompts.secret(`${keyName}: `);
    if (!key) throw new CodingSkip(`${keyName} cannot be empty`);
    config[keyName] = key;
  } else if (!config[keyName] && deps.env[keyName]) {
    // The coding proxy container reads the key from the quickstart env file.
    config[keyName] = deps.env[keyName]!;
  }
  return provider;
}

function startProxy(paths: QuickstartPaths, state: QuickstartState, deps: CodingDeps): void {
  const env = readQuickstartEnv(paths);
  const files = quickstartComposeFiles(deps.packageRoot, env).flatMap((file) => ["--file", file]);
  const args = ["compose", "--project-name", state.composeProject, "--env-file", paths.envFile, ...files];
  const result = deps.run("docker", [...args, "up", "--detach", "--wait", "--wait-timeout", "90", "coding-proxy"], {
    cwd: paths.projectDir,
    env: { ...deps.env, ...env, WARDBY_PROJECT_DIR: paths.projectDir },
  });
  if (result.status !== 0) {
    throw new CodingSkip(`the coding proxy did not start: ${(result.stderr || result.stdout).trim().split("\n")[0]}`);
  }
}

/** Git repositories among the trusted folders: a folder that is one, else its direct (non-hidden) children. */
async function findRepositories(scan: string[], roots: string[]): Promise<string[]> {
  const found: string[] = [];
  const add = (path: string) => {
    if (!found.includes(path)) found.push(path);
  };
  for (const root of scan) {
    if (await isRepositoryTop(root, roots)) {
      add(root);
      continue;
    }
    let names: string[];
    try {
      names = readdirSync(root, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith(".") && (entry.isDirectory() || entry.isSymbolicLink()))
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const name of names) {
      let real: string;
      try {
        real = realpathSync(join(root, name));
        if (!statSync(real).isDirectory()) continue;
      } catch {
        continue;
      }
      // A symlink out of the trusted folder is not a candidate; resolveLocalRepository checks the roots.
      if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) continue;
      // Cheap pre-check (a .git directory or file) before spawning git.
      if (!existsSync(join(real, ".git"))) continue;
      if (await isRepositoryTop(real, roots)) add(real);
    }
  }
  return found;
}

async function chooseRepository(roots: string[], opts: CodingStepOptions, deps: CodingDeps): Promise<string | null> {
  // Folders passed with --trust on this run take precedence over the saved ones.
  const thisRun: string[] = [];
  for (const path of opts.trust) {
    try {
      thisRun.push(realpathSync(resolve(path)));
    } catch {
      // chooseRoots already rejected a missing folder.
    }
  }
  let found = await findRepositories(thisRun, roots);
  if (found.length === 0) found = await findRepositories(roots, roots);
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    if (opts.nonInteractive) {
      deps.log(`Found ${found.length} git repositories in the trusted folders; using ${found[0]}:`);
      for (const repo of found) deps.log(`  ${repo}`);
      deps.log("  To use another, re-run quickstart with --trust <repo>.");
      return found[0];
    }
    deps.log("Git repositories found in the trusted folders:");
    found.forEach((repo, index) => deps.log(`  [${index + 1}] ${repo}`));
    for (;;) {
      const answer = await deps.prompts.line(`Which repository should the agents use? [1-${found.length}] `, "1");
      const index = Number(answer.trim()) - 1;
      if (Number.isInteger(index) && index >= 0 && index < found.length) return found[index];
      deps.log(`! Enter a number from 1 to ${found.length}.`);
    }
  }
  if (opts.nonInteractive) return null;
  for (;;) {
    const answer = await deps.prompts.line(
      "Git repository for the agents (inside a trusted folder; blank = skip): ",
      "",
    );
    if (!answer) return null;
    try {
      return (await resolveLocalRepository(`${LOCAL_REPO_PREFIX}${resolve(answer)}`, roots)).path;
    } catch (error) {
      deps.log(`! ${(error as Error).message}`);
    }
  }
}

async function chooseStarter(branch: string, opts: CodingStepOptions, deps: CodingDeps): Promise<StarterService[]> {
  if (opts.starterServices !== undefined) return opts.starterServices;
  if (opts.nonInteractive) return [];
  const answer = (
    await deps.prompts.line(
      `No .wardby/services.yaml on ${branch}. Create a starter on a new branch ${STARTER_SERVICES_BRANCH}? [p]ostgres, [r]edis, [b]oth, [n]one [n] `,
      "n",
    )
  ).toLowerCase();
  if (answer === "p" || answer === "postgres") return ["postgres"];
  if (answer === "r" || answer === "redis") return ["redis"];
  if (answer === "b" || answer === "both") return ["postgres", "redis"];
  return [];
}

async function pullServiceImages(services: DeclaredService[], deps: CodingDeps): Promise<void> {
  if (services.length === 0) return;
  for (const { service, image } of await deps.catalogImages(services)) {
    const label = `${service.name} ${service.version}`;
    if (!image) deps.log(`! ${label} is not in the service catalog; runs that declare it will be refused.`);
    else if (deps.run("docker", ["pull", image], { inherit: true }).status !== 0) {
      deps.log(`! Could not pull the ${label} image (${image}); a run will pull it when it starts.`);
    }
  }
}

/** Reads (or offers to create) the repository's services.yaml; returns the service names the builder may start. */
async function prepareServices(
  repo: string,
  roots: string[],
  branch: string,
  baseSha: string,
  opts: CodingStepOptions,
  deps: CodingDeps,
): Promise<string[]> {
  // Read at the exact commit a starter would be built on, so the two cannot disagree.
  const declared = await inspectDeclaredServices(repo, roots, baseSha);
  if (declared.kind === "invalid") {
    deps.log(`! .wardby/services.yaml on ${branch} is invalid: ${declared.reason}`);
    deps.log("  Coding runs on that branch will be refused until it is fixed (see docs/coding-services.md).");
    return [];
  }
  if (declared.kind === "valid") {
    const list = declaredServicesLabel(declared);
    deps.log(`✓ .wardby/services.yaml on ${branch} declares: ${list || "no services"}`);
    await pullServiceImages(declared.services, deps);
    return declared.services.map((service) => service.name);
  }

  const choices = await chooseStarter(branch, opts, deps);
  if (choices.length === 0) {
    deps.log(
      `No .wardby/services.yaml on ${branch}; add one to start databases next to runs (docs/coding-services.md).`,
    );
    return [];
  }
  const result = await commitStarterServices({
    dir: repo,
    baseSha,
    content: starterServicesYaml(choices),
    confirmReplace: async (existing) => {
      if (opts.nonInteractive) return false;
      return await deps.prompts.yesNo(
        `Branch ${STARTER_SERVICES_BRANCH} already exists (at ${existing.slice(0, 12)}). Replace it?`,
        false,
      );
    },
  });
  if (result.status === "refused") {
    deps.log(`! Did not write the starter file: ${result.reason}`);
    return [];
  }
  if (result.status === "kept") {
    deps.log(`! Branch ${STARTER_SERVICES_BRANCH} already exists; left it unchanged.`);
  } else {
    deps.log(
      `✓ Committed a starter .wardby/services.yaml on branch ${STARTER_SERVICES_BRANCH} (your checkout is unchanged).`,
    );
  }
  deps.log(`  Merge ${STARTER_SERVICES_BRANCH} into ${branch}, or point ${BUILDER_AGENT} at it:`);
  deps.log(`  update_agent with codingProfile.baseRef = "${STARTER_SERVICES_BRANCH}"`);
  const services = starterDeclaredServices(choices);
  await pullServiceImages(services, deps);
  return services.map((service) => service.name);
}

/** For a Python repository, prepares the Node + Python 3.12 workspace image; true when the builder should use it. */
async function preparePythonWorkspace(
  paths: QuickstartPaths,
  provider: CodingProvider,
  repo: string,
  sha: string,
  deps: CodingDeps,
): Promise<boolean> {
  if (!(await detectPythonProject(repo, sha))) return false;
  let image: string | undefined;
  try {
    image = prepareNodePythonImage(provider, readQuickstartEnv(paths), deps);
  } catch (error) {
    if (!(error instanceof CodingSkip)) throw error;
    deps.log(`! ${error.message}.`);
  }
  if (!image) {
    deps.log(
      "! Python project detected, but this version has no Python workspace image; the builder can edit code but not run Python tests. Upgrade, or set CODING_WORKER_IMAGE_NODE_PYTHON_3_12 / CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12",
    );
    return false;
  }
  writeQuickstartEnv(paths, { ...readQuickstartEnv(paths), [NODE_PYTHON_ENV[provider]]: image });
  deps.log("Python project detected: local-builder uses a Node + Python 3.12 workspace");
  return true;
}

const SHOWN_PACKAGE_NAMES = 12;
const PACKAGE_ECOSYSTEMS = [
  ["npm", "npm"],
  ["pypi", "PyPI"],
] as const;
const ADD_PACKAGES_LATER = `update_agent with codingProfile.packageAllowlist (docs/coding-packages.md)`;

/**
 * Offers the packages the repository declares at `sha` as the builder's
 * allowlist; returns it when allowed, undefined otherwise (no packages).
 */
async function chooseRepoPackages(
  repo: string,
  branch: string,
  sha: string,
  opts: CodingStepOptions,
  deps: CodingDeps,
): Promise<Record<string, string[]> | undefined> {
  const { allowlist, notes } = await readRepoPackages(repo, sha);
  for (const note of notes) deps.log(`! ${note}`);
  const present = PACKAGE_ECOSYSTEMS.filter(([key]) => allowlist[key]?.length);
  if (present.length === 0) return undefined;

  deps.log(
    `Packages declared on ${branch}: ${present.map(([key, label]) => `${allowlist[key]!.length} ${label}`).join(", ")}`,
  );
  let shown = 0;
  let total = 0;
  for (const [key, label] of present) {
    const names = allowlist[key]!;
    total += names.length;
    const slice = names.slice(0, Math.max(0, SHOWN_PACKAGE_NAMES - shown));
    shown += slice.length;
    if (slice.length > 0) deps.log(`  ${label}: ${slice.join(", ")}`);
  }
  if (total > shown) deps.log(`  … and ${total - shown} more`);

  let allow = opts.allowRepoPackages;
  if (allow === undefined && opts.nonInteractive) {
    deps.log(`Not allowing them: pass --allow-repo-packages to allow them, or later: ${ADD_PACKAGES_LATER}.`);
    return undefined;
  }
  if (allow === undefined) {
    allow = await deps.prompts.yesNo(
      `Allow ${BUILDER_AGENT} to install these packages through Wardby's registry?`,
      true,
    );
  }
  if (!allow) {
    deps.log(`${BUILDER_AGENT} may not install packages. To allow some later: ${ADD_PACKAGES_LATER}.`);
    return undefined;
  }
  deps.log(
    `✓ ${BUILDER_AGENT} may install these packages through Wardby's registry; release-age, advisory, and record checks still apply.`,
  );
  return Object.fromEntries(present.map(([key]) => [key, allowlist[key]!]));
}

function seedLines(seed: CodingSeedResult, repository: string): string[] {
  const lines: string[] = [];
  for (const [name, outcome] of [
    [BUILDER_AGENT, seed.builder],
    [REVIEWER_AGENT, seed.reviewer],
  ] as const) {
    if (outcome.status === "skipped") lines.push(`! ${name}: ${outcome.reason}`);
    else lines.push(`✓ ${name} ${outcome.status} for ${repository}`);
  }
  if (seed.builder.status !== "skipped" && seed.reviewer.status !== "skipped") {
    lines.push(
      "",
      "Try them from your MCP client (or ask your assistant to make these calls):",
      `  trigger_agent {"agentId": "${seed.builder.id}", "task": "Add a short CONTRIBUTING.md"}`,
      "  The run pushes a branch wardby/run-<run id> into your repository (get_run shows it). Review it with:",
      `  trigger_agent {"agentId": "${seed.reviewer.id}", "review": {"branch": "wardby/run-<run id>"}}`,
    );
  }
  return lines;
}

export async function codingStep(
  paths: QuickstartPaths,
  state: QuickstartState,
  opts: CodingStepOptions,
  deps: CodingDeps,
): Promise<CodingStepResult | null> {
  if (opts.coding === false) return null;
  if (opts.coding === undefined) {
    if (opts.nonInteractive) return null;
    if (!(await deps.prompts.yesNo("Set up coding + review agents against a local git repo?", false))) return null;
  }

  try {
    const config = readQuickstartEnv(paths);
    const existing = loadLocalRepoRoots({ LOCAL_REPO_ROOTS: config.LOCAL_REPO_ROOTS });
    for (const missing of existing.missing) deps.log(`! Dropping trusted folder ${missing}: it no longer exists.`);
    const roots = await chooseRoots(opts, existing.roots, deps);
    const provider = await chooseProvider(opts, config, deps);
    const images = prepareImages(provider, config, deps);

    const next: Record<string, string> = {
      ...config,
      ...codingEnvUpdates({
        roots,
        provider,
        workerImage: images.worker,
        runtimeImage: images.runtime,
        claudeWorkerImage: images.claudeWorker,
        claudeToolRunnerImage: images.claudeToolRunner,
      }),
    };
    // An earlier quickstart run, or a manual setting, may have pointed CODING_WORKER_IMAGE at the Claude
    // worker; that would start the wrong driver for a Codex run. A real Codex worker from a Codex run stays.
    const staleClaude = [config.CODING_CLAUDE_WORKER_IMAGE, images.claudeWorker].filter(Boolean);
    if (provider === "claude-code" && staleClaude.includes(next.CODING_WORKER_IMAGE)) delete next.CODING_WORKER_IMAGE;
    writeQuickstartEnv(paths, next);
    deps.log(`✓ Trusted folders: ${roots.join(", ")}`);

    startProxy(paths, state, deps);
    deps.log(`✓ Coding proxy is running (${CODING_PROXY_CONTAINER})`);
    const preflight = await dockerCodingPreflight(
      {
        workerImage: images.worker,
        claudeWorkerImage: images.claudeWorker,
        claudeToolRunnerImage: images.claudeToolRunner,
        proxyContainer: CODING_PROXY_CONTAINER,
      },
      async (image) => deps.run("docker", ["image", "inspect", image]).status === 0,
    );
    if (preflight) throw new CodingSkip(`coding preflight failed: ${preflight}`);
    deps.log("✓ Coding preflight passed");

    const repo = await chooseRepository(roots, opts, deps);
    if (!repo) {
      deps.log("No git repository was found in or directly under the trusted folders; the agents were not created.");
      return { roots, provider };
    }
    const base = await repoDefaultBranch(repo);
    if (!base) {
      deps.log(`! ${repo} has no checked-out branch with commits; the agents were not created.`);
      return { roots, provider };
    }
    const services = await prepareServices(repo, roots, base.branch, base.sha, opts, deps);
    const python = await preparePythonWorkspace(paths, provider, repo, base.sha, deps);
    const packageAllowlist = await chooseRepoPackages(repo, base.branch, base.sha, opts, deps);
    const repository = `${LOCAL_REPO_PREFIX}${repo}`;
    const seed = await deps.seed({
      provider,
      builderModel: defaultModel(provider === "codex" ? "openai" : "anthropic"),
      reviewerModel: defaultReviewerModel(state.provider),
      repository,
      baseRef: base.branch,
      services,
      ...(python ? { toolchain: "node-python" as const, toolchainVersion: "3.12" } : {}),
      ...(packageAllowlist ? { packageAllowlist } : {}),
    });
    for (const line of seedLines(seed, repository)) deps.log(line);
    return { roots, provider, repository, seed };
  } catch (error) {
    if (!(error instanceof CodingSkip)) throw error;
    deps.log(`! Skipped the coding step: ${error.message}.`);
    return null;
  }
}
