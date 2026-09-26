import { loadGitHubVcsConfig } from "../../config/providers.js";
import { GitHubAppClient } from "../vcs/github.js";
import { GitHubReviewHost } from "./github.js";
import type { ReviewHostRegistry } from "./types.js";

export * from "./types.js";
export { GitHubReviewHost } from "./github.js";

/** One host per configured provider; empty when no GitHub App is configured (the repo_* tools are then never offered). */
export function buildReviewHosts(env: NodeJS.ProcessEnv = process.env): ReviewHostRegistry {
  const github = loadGitHubVcsConfig(env);
  if (!github.appId || !github.privateKey) return {};
  return {
    github: new GitHubReviewHost(
      new GitHubAppClient({ appId: github.appId, privateKey: github.privateKey, apiVersion: github.apiVersion }),
    ),
  };
}
