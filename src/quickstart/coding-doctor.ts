/**
 * The coding section of `wardby doctor` / `wardby status` for a quickstart
 * project: trusted folders, the worker image, the coding proxy, and for each
 * agent with a local repository whether it is inside the trusted folders and
 * what its committed `.wardby/services.yaml` declares. Lines start with ✓ or ✗
 * like the rest of doctor's output; an empty list means the coding step was
 * never configured.
 */
import { LOCAL_REPO_PREFIX, LocalRepoError, loadLocalRepoRoots, resolveLocalRepository } from "../coding/local-repo.js";
import { imageVariable } from "../config/providers.js";
import { isImmutableDockerImage } from "../providers/jobs/docker-isolation.js";
import { CODING_PROXY_CONTAINER, type RunCommand } from "./coding.js";
import { declaredServicesLabel, inspectDeclaredServices, repoDefaultBranch } from "./starter-services.js";

export interface LocalAgent {
  name: string;
  /** `local:/abs/path`. */
  repository: string;
  /** The branch whose services.yaml applies (a coding agent's baseRef); default: the checked-out branch. */
  ref?: string;
  /** A coding agent's workspace toolchain, shown by doctor. */
  toolchain?: string;
  toolchainVersion?: string | null;
}

export interface CodingDoctorDeps {
  run: RunCommand;
  listLocalAgents: () => Promise<LocalAgent[]>;
}

const ok = (name: string, detail?: string) => `✓ ${name}${detail ? ` (${detail})` : ""}`;
const bad = (name: string, detail?: string) => `✗ ${name}${detail ? ` (${detail})` : ""}`;

async function agentLines(agent: LocalAgent, roots: string[]): Promise<string[]> {
  let path: string;
  try {
    path = (await resolveLocalRepository(agent.repository, roots)).path;
  } catch (error) {
    const message = error instanceof LocalRepoError ? error.message : String(error);
    return [`✗ ${agent.name}: ${message}`];
  }
  const lines = [`✓ ${agent.name}: ${path} is inside the trusted folders`];
  if (agent.toolchain) {
    lines.push(
      `✓ ${agent.name}: toolchain ${agent.toolchain}${agent.toolchainVersion ? ` ${agent.toolchainVersion}` : ""}`,
    );
  }
  const ref = agent.ref ?? (await repoDefaultBranch(path))?.branch;
  if (!ref) return [...lines, `✗ ${agent.name}: ${path} has no checked-out branch with commits`];
  const declared = await inspectDeclaredServices(path, roots, ref);
  if (declared.kind === "absent") lines.push(`✓ ${agent.name}: no .wardby/services.yaml on ${ref} (no services)`);
  else if (declared.kind === "invalid") {
    lines.push(`✗ ${agent.name}: .wardby/services.yaml on ${ref} is invalid: ${declared.reason}`);
  } else {
    const list = declaredServicesLabel(declared);
    lines.push(`✓ ${agent.name}: .wardby/services.yaml on ${ref} declares ${list || "no services"}`);
  }
  return lines;
}

export async function codingDoctorLines(
  env: Record<string, string | undefined>,
  deps: CodingDoctorDeps,
): Promise<string[]> {
  if (!env.LOCAL_REPO_ROOTS && env.JOB_LAUNCHER !== "docker") return [];
  const lines: string[] = [];
  const { roots, missing } = loadLocalRepoRoots({ LOCAL_REPO_ROOTS: env.LOCAL_REPO_ROOTS });
  for (const root of roots) lines.push(ok(`Trusted folder ${root}`));
  for (const root of missing) lines.push(bad(`Trusted folder ${root}`, "does not exist"));
  if (roots.length === 0 && missing.length === 0) lines.push(bad("Trusted folders", "LOCAL_REPO_ROOTS is empty"));

  // Each provider's images are optional (Codex: CODING_WORKER_IMAGE; Claude Code: its pair); check what is set.
  // Blank is unset, as the server reads it (imageVariable).
  const codexSet = Boolean(imageVariable(env.CODING_WORKER_IMAGE));
  const claudeSet = Boolean(
    imageVariable(env.CODING_CLAUDE_WORKER_IMAGE) || imageVariable(env.CODING_CLAUDE_TOOL_RUNNER_IMAGE),
  );
  const checkImage = (label: string, name: string) => {
    const image = imageVariable(env[name]);
    if (!image) lines.push(bad(label, `${name} is not set`));
    else if (!isImmutableDockerImage(image)) lines.push(bad(label, `${name} must be an immutable digest or image id`));
    else if (deps.run("docker", ["image", "inspect", image]).status !== 0) {
      lines.push(bad(label, "Docker cannot inspect it; re-run quickstart"));
    } else lines.push(ok(label));
  };
  if (codexSet) checkImage("Coding worker image", "CODING_WORKER_IMAGE");
  if (claudeSet) {
    checkImage("Claude Code worker image", "CODING_CLAUDE_WORKER_IMAGE");
    checkImage("Claude Code tool runner image", "CODING_CLAUDE_TOOL_RUNNER_IMAGE");
  }
  if (!codexSet && !claudeSet) {
    lines.push(
      bad(
        "Coding worker image",
        "set CODING_WORKER_IMAGE for Codex, or CODING_CLAUDE_WORKER_IMAGE and CODING_CLAUDE_TOOL_RUNNER_IMAGE for Claude Code",
      ),
    );
  }

  const proxy = deps.run("docker", ["inspect", "--format", "{{.State.Running}}", CODING_PROXY_CONTAINER]);
  const running = proxy.status === 0 && proxy.stdout.trim() === "true";
  lines.push(
    running
      ? ok(`Coding proxy container (${CODING_PROXY_CONTAINER})`)
      : bad(`Coding proxy container (${CODING_PROXY_CONTAINER})`, "not running"),
  );

  for (const agent of await deps.listLocalAgents()) {
    if (!agent.repository.startsWith(LOCAL_REPO_PREFIX)) continue;
    lines.push(...(await agentLines(agent, roots)));
  }
  return lines;
}
