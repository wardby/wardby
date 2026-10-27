import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GitHubVcsConfig, ProviderConfig } from "../../config/providers.js";
import { GitHubAppClient } from "./github.js";
import { GitVcsProvider } from "./git.js";
import { loadLocalRepoRoots } from "../../coding/local-repo.js";
import { GitHubRemote } from "./github-remote.js";
import { LocalRemote } from "./local-remote.js";
import { RoutingVcsProvider } from "./routing.js";
import type { VcsProvider } from "./types.js";
import { logger } from "../../core/logger.js";
import { testSimulatorBase } from "../../config/test-simulators.js";

const vcsLog = logger.child({ module: "vcs" });

export * from "./types.js";
export { GitHubAppClient } from "./github.js";
export { GitVcsProvider, NodeGitCommandRunner } from "./git.js";
export { GitHubRemote } from "./github-remote.js";
export { LocalRemote } from "./local-remote.js";
export { RoutingVcsProvider, VCS_GITHUB_NOT_CONFIGURED_ERROR } from "./routing.js";
export type { GitRemote, PublishInput, PublishResult } from "./remote.js";

export interface BuildVcsProviderOptions {
  /** Startup warnings; the module logger by default. */
  warn?: (message: string) => void;
}

/**
 * GitHub is built only with App credentials, local repositories only with
 * LOCAL_REPO_ROOTS; neither being set is allowed (the server still starts) and
 * surfaces when a repository of the missing kind is used (see
 * RoutingVcsProvider). With neither configured no coding run can succeed, so a
 * startup warning names both options. Only container launchers build this.
 */
export function buildVcsProvider(
  providerConfig: Pick<ProviderConfig, "vcs">,
  config: GitHubVcsConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: BuildVcsProviderOptions = {},
): VcsProvider {
  if (providerConfig.vcs !== "github") throw new Error(`VCS_PROVIDER=${String(providerConfig.vcs)} is not supported.`);
  const rootDir = resolve(config.workRoot ?? resolve(tmpdir(), "wardby-vcs"));
  const limits = { maxChangedFiles: config.maxChangedFiles, maxDiffBytes: config.maxDiffBytes };
  let github: VcsProvider | null = null;
  if (config.appId && config.privateKey) {
    const client = new GitHubAppClient({
      appId: config.appId,
      privateKey: config.privateKey,
      apiVersion: config.apiVersion,
    });
    // WARDBY_TEST_SIMULATORS (test only): clone from and push to the simulator's git server.
    const simulatorGit = testSimulatorBase("github-git", env);
    const remote = new GitHubRemote({
      github: client,
      ...(simulatorGit ? { cloneUrlForRepository: (repository: string) => `${simulatorGit}/${repository}.git` } : {}),
    });
    github = new GitVcsProvider({ rootDir, remote, ...limits });
  }
  let local: VcsProvider | null = null;
  if (loadLocalRepoRoots(env).roots.length > 0) {
    // Re-read per call so a root that disappears (or appears) takes effect without a restart.
    local = new GitVcsProvider({
      rootDir,
      remote: new LocalRemote({ roots: () => loadLocalRepoRoots(env).roots }),
      ...limits,
    });
  }
  if (!github && !local) {
    const warn = options.warn ?? ((message: string) => vcsLog.warn(message));
    warn(
      "No repositories are configured for coding agents: set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY " +
        "for GitHub repositories, or LOCAL_REPO_ROOTS for local git repositories on this server. " +
        "Coding runs fail until one of them is set.",
    );
  }
  return new RoutingVcsProvider({ github, local });
}
