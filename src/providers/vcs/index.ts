import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { GitHubVcsConfig, ProviderConfig } from "../../config/providers.js";
import { GitHubAppClient } from "./github.js";
import { GitVcsProvider } from "./git.js";
import type { VcsProvider } from "./types.js";

export * from "./types.js";
export { GitHubAppClient } from "./github.js";
export { GitVcsProvider, NodeGitCommandRunner } from "./git.js";

export function buildVcsProvider(providerConfig: Pick<ProviderConfig, "vcs">, config: GitHubVcsConfig): VcsProvider {
  if (providerConfig.vcs !== "github") throw new Error(`VCS_PROVIDER=${String(providerConfig.vcs)} is not supported.`);
  if (!config.appId || !config.privateKey) {
    throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required by the GitHub VCS adapter.");
  }
  const rootDir = resolve(config.workRoot ?? resolve(tmpdir(), "reevo-vcs"));
  const github = new GitHubAppClient({
    appId: config.appId,
    privateKey: config.privateKey,
    apiVersion: config.apiVersion,
  });
  return new GitVcsProvider({
    rootDir,
    github,
    maxChangedFiles: config.maxChangedFiles,
    maxDiffBytes: config.maxDiffBytes,
  });
}
