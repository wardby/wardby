# Host providers

A host provider adds a code host to Wardby using your own custom tools. You can add
a host, or fix one, without a Wardby release.

Host providers are being added in stages. **This release (0.8.0) lets you register a
provider, approve its tools and test them. Agents can't use a registered provider yet**,
and `link_repository` still refuses its repositories.

## Who can manage one

Every host provider tool (`register_host_provider`, `approve_host_provider_tools`,
`get_host_provider`, `test_host_provider`, `delete_host_provider`) needs the
`hosts:admin` scope and a role that grants it (`admin` or `host-manager`), or the local
stdio operator. Bound tools decide who has permission and who wrote a comment, so treat
this like `agents:admin`. See
[getting-started-identity-provider.md](getting-started-identity-provider.md#wardby-roles)
for defining the scope and mapping the role.

Providers are shared by every host manager: any host manager can read and re-register any
provider, including its tool code, whoever owns the tools it names.

## Register a provider

1. Create a tool for each operation with `create_tool`. Each does one host call. See
   [Tool contract](#tool-contract).
2. Store each credential with `create_secret`, and broker it with `set_secret_broker`
   ([tool-secrets.md](tool-secrets.md)). Allow every API host and place it in a header or
   query parameter. Repository credentials also allow the git host; the permission
   credential needs only the API hosts.
3. Store a webhook secret of at least 16 characters. Don't attach it to any agent.
4. Call `register_host_provider`:

   ```json
   {
     "provider": "your-host",
     "gitHost": "git.example.com",
     "apiHosts": ["api.example.com"],
     "gitUsername": "x-token-auth",
     "pullRequestUrlTemplate": "https://git.example.com/{repository}/pull/{number}",
     "repositoryApiPath": "/2.0/repositories/{repository}",
     "webhook": {
       "header": "X-Hub-Signature",
       "algorithm": "sha256",
       "deliveryHeader": "X-Request-UUID",
       "eventHeader": "X-Event-Key",
       "secret": "your-webhook-secret"
     },
     "credentials": [{ "repositories": "your-workspace/*", "secret": "your-token" }],
     "trustedAccounts": ["<account id>"],
     "tools": { "getPullRequest": "your_get_pr_tool" }
   }
   ```

   Bind every required operation in `tools` (names here are placeholders), and any optional
   ones you want. For example:

   ```json
   "tools": {
     "getPullRequest": "your_get_pr", "listPullRequestFiles": "your_list_files",
     "getDiff": "your_get_diff", "readFile": "your_read_file", "listFiles": "your_list_dir",
     "listComments": "your_list_comments", "createComment": "your_create_comment",
     "submitVerdict": "your_submit_verdict", "findPullRequest": "your_find_pr",
     "openPullRequest": "your_open_pr", "updatePullRequest": "your_update_pr"
   }
   ```

5. Restart the server. Approvals don't need a restart, but a new provider does.

The tools and secrets you name must be yours. Secret rules, each refused with a named code:

- Credentials and `permissionCredential` must be brokered, placed in a header or query
  parameter, and allowed on the API hosts (credentials also on the git host; the permission credential needs only the API hosts).
- `permissionCredential` can't also be listed in `credentials`
  (`host_provider_permission_secret_shared`), so no other operation can reach it.
- The webhook secret can't be a credential or permission secret of any provider, and can't
  be attached to an agent (`host_provider_webhook_secret_shared`). `attach_secret` refuses
  it too.
- The webhook secret needs at least 16 characters (`host_provider_webhook_secret_short`).
- `gitUsername` can't be a credential's value and can't contain "username".

These provider names can't be used: `github`, `local`, `http`, `https`, `ssh`, `git`,
`file` and `constructor`. Names match `^[a-z][a-z0-9-]{1,30}$`.

These operations are required: `getPullRequest`, `listPullRequestFiles`, `getDiff`,
`readFile`, `listFiles`, `listComments`, `createComment`, `submitVerdict`,
`findPullRequest`, `openPullRequest` and `updatePullRequest`. These are optional:
`editComment`, `resolveThread`, `listCommitStatuses`, `setCommitStatus`,
`getRepositoryPermission` and `normalizeEvent`. `getRepositoryPermission` becomes required
when you set `permissionCredential`.

## Who may start a run

This is how it will work once agents can use a provider. Registering records your choice
now; nothing enforces it in this release.

| Setup                     | Situation                                | Result                            |
| ------------------------- | ---------------------------------------- | --------------------------------- |
| `permissionCredential`    | The host says the user has enough access | Run starts                        |
| `permissionCredential`    | The host says they don't                 | Refused, even if in the allowlist |
| `permissionCredential`    | The lookup fails                         | Refused, with no fallback         |
| No `permissionCredential` | The user is in `trustedAccounts`         | Run starts, at `write` level      |
| No `permissionCredential` | The user isn't in `trustedAccounts`      | Refused                           |

`permissionCredential` needs `permissionApiPath` (with `{workspace}` and `{repo}`) and a
bound `getRepositoryPermission`.

## Change a tool

Registering copies each tool's code and schema, and only that copy ever runs.
`update_tool` changes nothing until you approve it, so the last approved version keeps
working in the meantime.

1. Call `update_tool`.
2. Call `get_host_provider` with `includeCode: true`. Changed tools show `status: "changed"`.
3. Read the change, then call `approve_host_provider_tools` with the operation names. It
   applies from the next call.

Deleting a tool keeps its snapshot running, with `status: "tool_deleted"`. To change that
operation, bind a new tool by registering again. Registering again also approves every tool
at its current code.

## Test a provider

`test_host_provider` runs each approved read-only tool against one repository, using the
real credential:

```json
{
  "provider": "your-host",
  "repository": "your-host:your-workspace/your-repo",
  "pullRequest": 4,
  "headRef": "a-branch-with-a-pull-request",
  "ref": "a-commit-or-branch",
  "accountId": "<account id>"
}
```

Only `provider` and `repository` are required. Each other field enables the checks that need it:

| Field         | Checks it enables                                                                   |
| ------------- | ----------------------------------------------------------------------------------- |
| `pullRequest` | `getPullRequest`, `listPullRequestFiles`, `getDiff`, `listComments`                 |
| `headRef`     | `findPullRequest`                                                                   |
| `ref`         | `readFile`, `listFiles`, `listCommitStatuses` (defaults to the pull request's head) |
| `accountId`   | `getRepositoryPermission`                                                           |

Each result is an `outcome` of `pass`, `fail` (with a fixed code, below) or `skipped`. A skip has
one of these codes: `not_bound` (no tool bound), `needs_pull_request`, `needs_head_ref`,
`needs_ref`, `needs_account` (the field above is missing), `allowlist_mode` (no
`permissionCredential`, so no permission lookup) and `not_read_only` (a write operation, never run).

Write operations are skipped. A read-only tool can only send GET requests. The report holds
an operation, an outcome and a fixed code for each, and no response data, so you can share it.

| Code                                    | Meaning                                                          |
| --------------------------------------- | ---------------------------------------------------------------- |
| `host_unauthorized`, `host_forbidden`   | The host refused the credential for this call.                   |
| `host_not_found`                        | The host doesn't have what was asked for.                        |
| `host_rate_limited`, `host_unavailable` | Try again later.                                                 |
| `host_conflict`                         | The host refused because of the current state.                   |
| `host_tool_invalid_result`              | The tool's answer doesn't match its operation's shape.           |
| `host_tool_invalid_params`              | The tool's schema refused what Wardby sends it.                  |
| `host_tool_request_denied`              | The tool went outside what a bound tool may request (see below). |
| `host_tool_no_credential`               | No credential's `repositories` covers this repository.           |
| `host_tool_failed`                      | The tool threw an error. Its message is dropped on purpose.      |
| `host_tool_timeout`                     | The tool ran out of time or instructions.                        |

## Tool contract

Each tool receives `workspace`, `repo` and `repository` (`workspace/repo`), plus its
operation's input fields (below). Declare them in `paramsZod`.

A tool answers with its operation's result, or `{ "error": "<code>" }` when the host refused,
where the code is `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited` or
`unavailable`. Results are checked strictly: an extra key, a missing key or a wrong type fails the
call with `host_tool_invalid_result`.

A pull request object, as returned by `getPullRequest` and `findPullRequest`, has exactly:
`number` (positive integer), `title`, `body`, `author` (string or null), `state`, `merged`
(boolean), `draft` (boolean), `baseRef`, `headRef`, `headSha` (non-empty), `isFork` (boolean) and
`htmlUrl` (a URL).

Read operations (method GET):

| Operation                 | Input fields  | Result                                                                                                                                                                                                                                  |
| ------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getPullRequest`          | `number`      | A pull request object.                                                                                                                                                                                                                  |
| `findPullRequest`         | `headRef`     | `{ pullRequest }`: a pull request object, or null if none.                                                                                                                                                                              |
| `listPullRequestFiles`    | `number`      | `{ files, nextPage }`. Each file: `filename`, `status`, `additions`, `deletions` (non-negative integers) and optionally `previousFilename`.                                                                                             |
| `getDiff`                 | `number`      | `{ diff }`: the unified diff text.                                                                                                                                                                                                      |
| `readFile`                | `ref`, `path` | `{ kind: "file", content }`, `{ kind: "directory" }` or `{ kind: "not_found" }`. No other keys.                                                                                                                                         |
| `listFiles`               | `ref`, `path` | `{ entries, nextPage }`. Each entry: `path`, `type` (`file` or `directory`) and optionally `size` (non-negative integer).                                                                                                               |
| `listComments`            | `number`      | `{ comments, nextPage }`. Each comment: `id` (non-empty), `author` and `authorId` (string or null), `body`, `createdAt`, `path` (string or null), `line` (positive integer or null), `parentId` (string or null), `resolved` (boolean). |
| `listCommitStatuses`      | `ref`         | `{ statuses, nextPage }`. Each status: `key`, `state` (`pending`, `success`, `failure` or `stopped`) and `url` (string or null).                                                                                                        |
| `getRepositoryPermission` | `accountId`   | `{ permission }`: `none`, `read`, `triage`, `write`, `maintain` or `admin`. Uses the permission credential and `permissionApiPath`.                                                                                                     |

Operations that page return `nextPage`: a string to continue from, or null at the end. Wardby
handles the paging, so the tool returns one page per call.

Write operations:

| Operation           | Method | Result                       |
| ------------------- | ------ | ---------------------------- |
| `openPullRequest`   | POST   | A pull request object.       |
| `updatePullRequest` | PUT    | A pull request object.       |
| `createComment`     | POST   | `{ id }` (non-empty string). |
| `editComment`       | PUT    | `{ id }` (non-empty string). |
| `resolveThread`     | POST   | `{}`                         |
| `submitVerdict`     | POST   | `{}`                         |
| `setCommitStatus`   | POST   | `{}`                         |

The input fields of the write operations are defined when agents can use a provider, in a later
release, so tools for them may need changing then. `test_host_provider` never runs them.

`normalizeEvent` makes no requests and isn't called yet.

Use `fetch(url, { secrets: ["host"] })`. Wardby resolves `host` to the credential for this
call's repository. A bound tool:

- reaches only `apiHosts`, over https on the default port, with no embedded credentials;
- stays under `repositoryApiPath` for this repository. `getRepositoryPermission` stays under
  `permissionApiPath` instead, and is the only operation that gets `permissionCredential`;
- uses its operation's method: GET for reads, and POST or PUT for writes;
- may set only the headers `accept`, `content-type`, `if-match` and `if-none-match`;
- makes at most three requests per call. No request follows a redirect, whether or not it
  carries a secret: follow a `Location` yourself, which counts as a request and goes through
  the same limits;
- has its path judged by what a server could turn it into: dot-only segments after decoding
  and encoded separators are refused. A few unusual file names can therefore be refused, and a
  repository path must be sent literally, not percent-encoded;
- has no datastore, shared datastore or readable secrets, and its `console` output is dropped;
- runs under the usual sandbox limits: 10 s per call, 8 s per fetch, 8 MiB per response.

Anything outside these limits fails the call with `host_tool_request_denied`, even if the
tool catches the error.

## Remove a provider

`delete_host_provider` removes a provider and its snapshots. It's refused while an agent links
to one of its repositories. `delete_secret` is refused while a provider uses that secret.
