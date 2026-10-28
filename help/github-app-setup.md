---
id: github-app-setup
title: Set up the GitHub App
summary: Step by step, create Wardby's GitHub App, choose its events and permissions, install it on your repositories, and give the server its credentials.
audience: operator
tags: [github, github-app, setup, permissions, webhooks, GITHUB_APP_ID, GITHUB_APP_WEBHOOK_SECRET, link_host_account]
appliesTo: ">=0.2.1"
---

# Set up the GitHub App

Wardby reaches GitHub through a GitHub App that you create and own. Each Wardby
server needs its own App, because an App has exactly one webhook URL. For an
overview of how Wardby uses the App, see
[Connect GitHub repositories](github.md).

Decide first what the App is for:

- **Coding agents only**, triggered with `trigger_agent` or on a schedule:
  GitHub never calls your server, so you can skip the webhook (step 2) and the
  events (step 4).
- **Review agents, `@`-mentions, review fix rounds, merge watchers, or
  marking pull requests ready**: these start from GitHub webhooks, so your
  server must be reachable over public HTTPS at the host of
  `MCP_CANONICAL_URI`.

## 1. Create the App

In the GitHub settings of the user or organization that will own it, open
**Developer settings**, then **GitHub Apps**, then **New GitHub App**. Give
it a name and a homepage URL. The owner matters: Wardby always serves the
App's owner, and other accounts only when you list them (step 7).

## 2. Webhook

- **Webhook URL**: `https://<your-host>/hosts/github/events`, where
  `<your-host>` is the host of `MCP_CANONICAL_URI`. Requests naming any other
  host are rejected.
- **Webhook secret**: a random value, for example from `openssl rand -hex 32`.
  The same value goes into `GITHUB_APP_WEBHOOK_SECRET` (step 7). Until that
  variable is set, the endpoint answers 404.

For coding agents only, untick **Active** under Webhook instead.

## 3. Repository permissions

| Permission      | Access                                             |
| --------------- | -------------------------------------------------- |
| Contents        | Read and write (Read for an App that only reviews) |
| Pull requests   | Read and write                                     |
| Checks          | Read and write                                     |
| Issues          | Read and write                                     |
| Commit statuses | Read (optional)                                    |

- **Contents: Read and write** lets coding agents push a branch for each pull
  request. A review-only App can have Read, but its reviewers then can't
  resolve their own fixed review threads.
- **Checks** carries the `wardby review` and `wardby merge order` checks.
- **Issues** covers mentions in issues and the labels used by
  [automatic review fix rounds](review-fix-rounds.md).
- **Commit statuses** lets reviewers see CI that reports commit statuses
  rather than check runs.

If you change permissions later, every installation must accept the new set
before its webhooks resume.

## 4. Events

Tick each one; every event is its own checkbox.

| Event                       | Needed for                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Pull request                | `pull_request` reviewers and `review_fix`                                                                   |
| Check run                   | Re-running the review check                                                                                 |
| Check suite                 | Reviews that wait for CI (`waitForCi`), and `markReadyWhenPassing` marking a draft ready once CI goes green |
| Issue comment               | `@`-mentions in issue and pull request comments                                                             |
| Issues                      | `@`-mentions in a newly opened or edited issue                                                              |
| Pull request review comment | `@`-mentions in inline review threads                                                                       |
| Push                        | The `push` trigger (merge-watcher agents)                                                                   |

Missing an event fails quietly: the matching trigger never starts. A common
case is leaving out Check suite, so drafts that should be marked ready stay
drafts.

## 5. Account linking

`link_host_account` lets a Wardby user prove which GitHub account they are, so
Wardby can check their repository access. In the App's **General** settings:

- **Callback URL**: `https://<your-host>/hosts/github/user-callback`.
- Leave **Request user authorization (OAuth) during installation** unticked.
- Note the **Client ID** (not the numeric App ID) and generate a **client
  secret**.

## 6. Private key and installation

1. Save the App, note its numeric **App ID**, and generate a **private key**
   (a `.pem` file).
2. Under **Install App**, install it on your account or organization and
   choose **Only select repositories**: pick only the repositories your agents
   may use.

## 7. Configure Wardby

| Variable                         | Value                                                                       |
| -------------------------------- | --------------------------------------------------------------------------- |
| `GITHUB_APP_ID`                  | The numeric App ID                                                          |
| `GITHUB_APP_PRIVATE_KEY`         | The contents of the `.pem` file                                             |
| `GITHUB_APP_WEBHOOK_SECRET`      | The webhook secret from step 2                                              |
| `GITHUB_APP_CLIENT_ID`           | The Client ID from step 5 (set together with the client secret, or neither) |
| `GITHUB_APP_CLIENT_SECRET`       | The client secret from step 5                                               |
| `WARDBY_GITHUB_ALLOWED_ACCOUNTS` | Optional: accounts other than the App's owner to serve, comma-separated     |
| `WARDBY_MENTION_EXPLANATIONS`    | Optional: `false` = no reply saying why a mention started nothing           |

Restart the server after setting them. Without `GITHUB_APP_ID` and
`GITHUB_APP_PRIVATE_KEY`, coding runs on GitHub repositories fail with
[`vcs_github_not_configured`](errors/vcs-github-not-configured.md).
Repositories of accounts that aren't served are refused with
[`github_account_not_allowed`](errors/github-account-not-allowed.md).

## 8. Check it

- Run `link_host_account` and finish the GitHub sign-in it opens.
- Link an agent with `link_repository`, or create a coding agent on the
  repository (see [builder agents](builder-agent.md) and
  [Run GitHub code-review agents](code-review-agents.md)).
- In the App's **Advanced** settings, **Recent Deliveries** should show your
  server answering webhooks with a 2xx status. A signature failure there means
  the webhook secret and `GITHUB_APP_WEBHOOK_SECRET` differ.

The full reference, including rollout order on Kubernetes deployments, is
[Registering the GitHub App](../docs/code-review-agents.md#registering-the-github-app).
