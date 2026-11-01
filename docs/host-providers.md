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
   ([tool-secrets.md](tool-secrets.md)). Allow every API host and the git host, and place it
   in a header or query parameter.
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

   The `tools` map above is shortened: bind every required operation.

5. Restart the server. Approvals don't need a restart, but a new provider does.

The tools and secrets you name must be yours. Secret rules, each refused with a named code:

- Credentials and `permissionCredential` must be brokered, placed in a header or query
  parameter, and allowed on the API hosts (credentials also on the git host).
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
  "accountId": "<account id>"
}
```

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
operation's fields. Declare them in `paramsZod`.

A tool answers with its operation's result, or `{ "error": "<code>" }` when the host refused,
where the code is `unauthorized`, `forbidden`, `not_found`, `conflict`, `rate_limited` or
`unavailable`.

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
