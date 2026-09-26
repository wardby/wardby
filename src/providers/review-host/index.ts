import { loadGitHubUserAuthConfig, loadGitHubVcsConfig } from "../../config/providers.js";
import { GitHubAppClient } from "../vcs/github.js";
import { GitHubReviewHost } from "./github.js";
import { GitHubUserAuthorizer } from "./github-user-auth.js";
import type { HostUserAuthorizerRegistry, ReviewHostRegistry } from "./types.js";

export * from "./types.js";
export { GitHubReviewHost } from "./github.js";
export { GitHubUserAuthorizer } from "./github-user-auth.js";

function githubClient(env: NodeJS.ProcessEnv): GitHubAppClient | null {
  const github = loadGitHubVcsConfig(env);
  if (!github.appId || !github.privateKey) return null;
  return new GitHubAppClient({ appId: github.appId, privateKey: github.privateKey, apiVersion: github.apiVersion });
}

/** One host per configured provider; empty when no GitHub App is configured (the repo_* tools are then never offered). */
export function buildReviewHosts(env: NodeJS.ProcessEnv = process.env): ReviewHostRegistry {
  const client = githubClient(env);
  return client ? { github: new GitHubReviewHost(client) } : {};
}

/**
 * One identity-linking flow per provider whose App has OAuth client
 * credentials (GITHUB_APP_CLIENT_ID/SECRET). Empty = link_host_account is
 * disabled; repository authorization is enforced either way.
 */
export function buildHostUserAuthorizers(env: NodeJS.ProcessEnv = process.env): HostUserAuthorizerRegistry {
  const client = githubClient(env);
  const { clientId, clientSecret } = loadGitHubUserAuthConfig(env);
  if (!client || !clientId || !clientSecret) return {};
  return { github: new GitHubUserAuthorizer({ client, clientId, clientSecret }) };
}
