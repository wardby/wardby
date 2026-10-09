# Wardby viewer (desktop)

A desktop app that shows what is running in a Wardby deployment as a live
graph: triggers, runs and sub-agent trees, turns and cost as they accrue,
outcomes (pull requests, comments, checks) and coding-run services. It is a
client of the read-only [admin viewer API](../../docs/viewer-api.md) and runs
no agents itself.

It is built with Tauri (a Rust core and a React UI). macOS is supported first.

## Download

Each Wardby release on GitHub has a matching macOS build of the viewer
attached: `wardby-viewer_<version>_macos-universal.dmg` (Apple Silicon and
Intel), with a `.sha256` checksum. Use the viewer from the same release as
your server.

The build is **not signed or notarized**, so macOS blocks it the first time.
After copying the app to Applications, either right-click it and choose
**Open**, then **Open** again, or remove the download quarantine:

```sh
xattr -dr com.apple.quarantine "/Applications/wardby viewer.app"
```

To check that a download was built by this repository's release workflow:

```sh
gh attestation verify wardby-viewer_<version>_macos-universal.dmg --repo wardby/wardby
```

To build it yourself instead, follow the rest of this guide.

## Prerequisites

- Node 24 (see `.nvmrc` at the repository root).
- Rust, installed with [rustup](https://rustup.rs). In a non-interactive shell,
  run `source ~/.cargo/env` first.
- Xcode Command Line Tools (`xcode-select --install`).

## Run it

Everything below runs in `apps/viewer`. The app has its own `package.json` and
lockfile and is not part of the server's build.

```sh
npm ci
npm run tauri dev
```

To build an application bundle:

```sh
npm run tauri build
```

Builds are not code signed or notarized. A bundle you built on your own
machine opens normally, because macOS only checks apps that were downloaded.
For a build that was downloaded or copied from another machine, macOS blocks
the first launch: open System Settings, then Privacy & Security, scroll to the
message about the app, and choose Open Anyway.

## Add a server and sign in

1. Choose to add a server and enter the server's canonical URI exactly as
   configured in `MCP_CANONICAL_URI`, including any path (for example
   `https://wardby.example.com/mcp`). The app also finds the server from an
   origin or other path on the same host. Plain `http` is accepted only for a
   loopback address such as `http://127.0.0.1:8080`.
2. Sign in. The app opens your system browser at the server's login page; the
   browser returns to a short-lived listener on `127.0.0.1` that the app opens
   for the duration of the sign-in.
3. The graph loads and then updates live.

The `⋯` menu next to the server name signs out of the server or removes it
from the list (after a confirmation). Signing out deletes the Keychain entry
and forgets the access token; the grant is not revoked at the server. Removing
a server also signs out of it.

The signed-in user needs the Wardby `admin` role, because the viewer API
requires the `admin:view` scope and only that role grants it. See
[Configure identity and privileged access](../../help/identity-and-access.md).

### Self-hosted sign-in

With `AUTH_PROVIDER=self-hosted` the app registers itself as a public client
automatically; no client id is needed. Create a user with the `admin` role and
a login key with `wardby auth` (see `wardby help auth`).

### External identity provider

If your identity provider does not offer dynamic client registration (the
case with `AUTH_PROVIDER=delegating`), register a public client with it and
enter its client id when adding the server. The client must:

- be a public client using the authorization code flow with PKCE (S256);
- have the loopback redirect URI `http://127.0.0.1/callback` (the app uses an
  available local port at sign-in time, and per RFC 8252 identity providers
  match everything except the port);
- be allowed to request the `admin:view` scope for the Wardby resource.

## Infrastructure view

The Infrastructure tab shows the Kubernetes namespace where a server runs coding
jobs: the control plane, the coding proxy, each run's pod with its containers and
sandbox, jobs, service accounts and their cloud identities, network policies,
ingress, and secret stores. **Map** draws them as zones; **Table** lists them
with status, CPU and memory, and age. Select a pod for its containers and recent
events; **Open run** jumps to the run that started it, and a coding run's
**Pod ↗** button jumps back to its pod while it is still running.

The tab has a cluster to show when the server uses the Kubernetes launcher (otherwise it says there is no cluster to show). It reads the
cluster with your own kubeconfig (`$KUBECONFIG` or `~/.kube/config`), using the
current context unless you choose another for that server, and it only reads.
The choice is saved per server. If your kubeconfig has no current context,
choose one from the context picker.
When `wardby serve` runs outside the cluster — for example against a local
[kind](https://kind.sigs.k8s.io/) cluster — the map shows the control plane as
outside the cluster, at the server's address.

On the Map, the left column follows a request's path: the public entry
(Gateway, Ingress or load balancer, noting any HTTP → HTTPS redirect), any
protection layer in front of the backends (on GKE, the Cloud Armor policy a
`GCPBackendPolicy` attaches), then the routes into the namespace. The
namespace's NetworkPolicies expand into one line per policy: a plain-English
summary of what it allows, built from its rules, with the exact selector and
rules underneath. The summary recognises common shapes (deny-all, DNS, the
internet over HTTPS, pod-to-pod access, and on GKE the load balancer ranges,
metadata server and Cloud SQL); anything else is shown literally, and
selectors written as `matchExpressions` aren't reflected in the summary.

A coding run's pod pulses while it is running. When the pod is deleted, its
card stays on the Map, marked **Ended**, until you close it or for two
minutes. On GKE, each pod card has a ↗ link to the pod in the Google Cloud
console; it needs the kube context to keep the name `gcloud` gives it
(`gke_<project>_<location>_<cluster>`).

Native agents set to run in a sandbox (`nativeExecutionMode: "sandbox"`) carry
an **SB** tag on the Runs graph, and their pods have their own **Agent
sandboxes** area on the Map and section in the Table, marked with the same tag.
Each run's pod links to its run, including a pod the run took from the warm
pool; idle warm pool pods show as dots with a ready count. A sandbox run's
**Pod ↗** button jumps to its pod. The view watches one namespace: if
`NATIVE_SANDBOX_NAMESPACE` puts sandboxes elsewhere, the Map says so instead of
showing them.

Credential plugins (`exec` entries in your kubeconfig) run with `/opt/homebrew/bin`,
`/usr/local/bin` and the Google Cloud SDK's `bin` directories added to `PATH`, so
`gke-gcloud-auth-plugin` (GKE) and the AWS CLI (EKS) are found when installed
there. Any other plugin must be on the `PATH` the app starts with. If sign-in
fails, run your cloud's login (for example `gcloud auth login`) and select
**Retry**.

To grant the viewer read-only Kubernetes access, create a `Role` and
`RoleBinding`. The following YAML is sufficient:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: wardby-viewer, namespace: wardby-coding }
rules:
  - apiGroups: [""]
    resources: [pods, services, serviceaccounts, events]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments]
    verbs: [get, list, watch]
  - apiGroups: [batch]
    resources: [jobs]
    verbs: [get, list, watch]
  - apiGroups: [networking.k8s.io]
    resources: [networkpolicies, ingresses]
    verbs: [get, list, watch]
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gateways, httproutes]
    verbs: [get, list, watch]
  - apiGroups: [networking.gke.io] # GKE only: shows Cloud Armor on the Gateway
    resources: [gcpbackendpolicies]
    verbs: [get, list, watch]
  - apiGroups: [external-secrets.io]
    resources: [secretstores, externalsecrets]
    verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: wardby-viewer, namespace: wardby-coding }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: Role, name: wardby-viewer }
subjects:
  - kind: User
    name: <you>
    apiGroup: rbac.authorization.k8s.io
```

Replace `wardby-coding` with the namespace where your coding runs execute, and
`<you>` with the user your kubeconfig signs in as (`kubectl auth whoami` shows
it; on GKE and EKS it is usually your cloud account's email or IAM identity).
For any resource you can't list, the tab names it: without `pods` the message
replaces the view, and for any other resource it appears above what the tab
could read. Without `secrets`, Secret names show as hidden instead. The `networking.gke.io`
rule applies to GKE only, and is optional: without it the tab just omits the
Cloud Armor detail.

The Role deliberately omits `secrets`, because Kubernetes RBAC cannot restrict
access to individual Secret names; Secret names appear as hidden in the
Infrastructure tab. If you prefer broader access, GKE IAM roles like
`roles/container.viewer` also work but grant additional permissions.

## Appearance

The viewer follows the system's light or dark appearance by default. To choose
one for the viewer only, use **View ▸ Appearance ▸ System, Light or Dark** in the
menu bar (⇧⌘L for Light, ⇧⌘D for Dark). The choice is remembered.

## Where tokens live

Tokens never reach the UI. The refresh token is stored in the macOS Keychain
(service `wardby-viewer`), one entry per server; the access token is held in
memory by the app's Rust core only. Signing out deletes the Keychain entry and
forgets the access token; the grant is not revoked at the server. The UI runs
under a strict content security policy with no network access of its own: all
requests go through the Rust core.

Because builds are not code signed, macOS may ask for your login password
again to let the app read its Keychain entry after you rebuild or update it.
Choose Always Allow to stop the prompts for that build.

## Development

```sh
npm test               # UI tests
npm run lint
npm run format:check
npm run gen:types      # regenerate src/api/generated.ts
```

Run `npm run gen:types` when the server's viewer schemas change. It reads the
JSON Schemas in `src/viewer/schemas/` at the repository root (regenerated with
`npm run build:viewer-schemas` there); the app never imports server source.

Rust checks, in `apps/viewer/src-tauri`:

```sh
cargo test
cargo clippy --all-targets -- -D warnings
cargo fmt --check
```

### End-to-end check against a local server

`src-tauri/tests/e2e_local.rs` runs the app's real sign-in and streaming code
against a running server in self-hosted mode, scripting the browser's login and
consent steps over HTTP. It is ignored by default:

```sh
WARDBY_E2E_URL=http://127.0.0.1:8080 \
WARDBY_E2E_LOGIN_KEY=<login key of an admin user> \
  cargo test --test e2e_local -- --ignored
```

`WARDBY_E2E_URL` is the server URL as you would enter it in the app. The test does not print tokens
or the login key.
