# Models and pricing

Wardby prices and shapes every model call from one catalog, not from a
hardcoded table inside each provider adapter. A model is usable by an agent
only when it is both in the catalog (shipped or added by an admin) and its
provider has credentials configured in this deployment.

## What the model catalog is

The catalog is the shipped set of models wardby ships with a release,
overlaid with this deployment's own entries. An entry carries everything
wardby needs to route, price, tokenize and shape calls to one model:

- `provider` — which adapter routes calls to it (`openai`, `anthropic`,
  `bedrock-claude`, `vertex-gemini`, or `google-ai-studio`).
- `modelId` — the exact string an agent's `model` field must equal.
- `encoding` — the tokenizer used to pre-count tokens for budget enforcement
  before any call.
- `inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok`, `cacheWritePerMTok` —
  USD per million tokens, the provider's own published rates.
- `efforts` — the reasoning-effort levels the model accepts, lowest to
  highest (empty means never send one).
- `thinkingMode` — how the model takes extended thinking; see "Thinking mode
  and effort" below.

A model id belongs to exactly one provider. If the shipped catalog has that
id, the shipped provider owns it permanently: no other provider can ever
register that id, no matter what — disabling or resetting an override of a
shipped model never frees it, because the shipped provider still owns the id
once the override is gone. For a model id the shipped catalog doesn't have,
whichever provider registered it first owns it (editing that entry later
does not change this) until someone with
`models:admin` runs `reset_model` on that id — disabling it is not enough,
since a disabled row still reserves the id for its provider.

## Reading it

`list_models` (`agents:read`) returns the merged catalog: every active entry,
or every entry including disabled ones with `includeDisabled: true`.
`get_model` (`agents:read`) returns one entry by `modelId`; for an override of
a shipped model it also returns the shipped entry the override shadows.
Neither tool exposes a secret — model prices and capabilities are visible to
anyone who can read agents, so they can choose a model responsibly.

Fields on a returned entry:

| Field                                                                      | Meaning                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `provider`                                                                 | Which adapter routes calls to this model.                                                             |
| `modelId`                                                                  | Exact string an agent's `model` must equal.                                                           |
| `inputPerMTok`, `outputPerMTok`, `cachedInputPerMTok`, `cacheWritePerMTok` | USD per million tokens.                                                                               |
| `efforts`                                                                  | Reasoning-effort levels this model accepts; empty means never send one.                               |
| `thinkingMode`                                                             | `adaptive`, `manual`, `level` or `none` — see below.                                                  |
| `origin`                                                                   | `shipped` (came with this release) or `override` (an admin's row).                                    |
| `priceVersion`                                                             | `shipped:<release version>` for a shipped entry, or the override row's last-updated timestamp.        |
| `routable`                                                                 | Whether this deployment can actually route to it right now (its provider has credentials configured). |
| `shippedDiffers`                                                           | Overrides of a shipped model only: whether the override's values now differ from the shipped ones.    |
| `sourceUrl`                                                                | Overrides only: the provider's own pricing page the rates were copied from.                           |

An entry with `routable: false` is in the catalog but cannot be used yet —
typically because the deployment hasn't configured credentials for that
provider.

## Who can change it

Changing the catalog (`set_model`, `disable_model`, `reset_model`) needs the
`models:admin` scope, honored only for a caller whose Wardby role grants it:
the built-in `admin` role, or the narrower `model-manager` role. A token that
merely carries the scope is not enough without one of those roles.

If your deployment delegates to an external identity provider, define the
`models:admin` scope there before you deploy a release that needs it — a
client that requests every advertised scope otherwise fails with
`invalid_scope` — and map `model-manager` (or `admin`) to the people who
maintain pricing; see
[Bring your own identity provider](getting-started-identity-provider.md#wardby-roles).

Every change is written to the control-plane log
(`event: models.catalog.set|disable|reset`, with the entry before and after
the change and the caller's principal id).

## Adding or overriding a model

`set_model` always takes a complete entry — every field is required, so
there is no partial update and the whole entry is always literal and
auditable:

```json
{
  "provider": "anthropic",
  "modelId": "claude-example-model",
  "encoding": "o200k_base",
  "inputPerMTok": 0.0,
  "outputPerMTok": 0.0,
  "cachedInputPerMTok": 0.0,
  "cacheWritePerMTok": 0.0,
  "efforts": ["low", "medium", "high"],
  "thinkingMode": "adaptive",
  "sourceUrl": "https://example.com/replace-with-the-providers-own-pricing-page"
}
```

The rate fields above are placeholders (`0.0`) — never invent or guess a
model's rates. Copy the provider's own published per-million-token numbers
for that exact model, including its cache read and cache write rates, from
its own pricing page, and set `sourceUrl` to that page. Never derive
`cachedInputPerMTok` or `cacheWritePerMTok` from `inputPerMTok` with a
multiplier: cache pricing can diverge between models even on the same
provider, and a formula that was once correct goes stale silently.
`set_model` accepts a zero rate but returns it as a warning, not an error,
so it never blocks a genuinely free or not-yet-priced entry — confirm the
zero against the source before leaving it.

`set_model` refuses (409) a `modelId` another provider already owns. For a
shipped id, that's permanent: the shipped provider owns it no matter what,
so no `set_model` call under a different provider can ever succeed for that
id. For a non-shipped id, the owning provider's row — active or disabled —
blocks every other provider until `reset_model` clears it (it takes only the
`modelId` and clears every row for it, whichever provider owns it);
`disable_model` alone never frees the id, since the disabled row still
reserves it.

## Thinking mode and effort

`thinkingMode` tells wardby how to ask a model for thinking, and must match
what that exact model actually accepts:

- `adaptive` — effort-based thinking (`{"type": "adaptive"}` plus an effort
  level from `efforts`). Most current Claude models.
- `manual` — a fixed thinking budget (`{"type": "enabled", "budget_tokens": …}`)
  and no effort level at all. Some smaller Claude models reject `adaptive`
  entirely.
- `none` — no thinking parameter is sent. Models without a thinking setting,
  including OpenAI.
- `level` — Gemini models. The agent's effort is sent as the model's
  thinking level (`low`, `medium`, `high`, `xhigh`, as listed in `efforts`).
  Gemini 4 models always think, so thinking cannot be turned off; with no
  effort set, Google's default level applies. See
  [Google Gemini](#google-gemini).

OpenAI models always use `none`; their reasoning is controlled by `efforts`
alone. Native agents call OpenAI's Responses API, and when the agent has an
`effort` that the model's `efforts` lists, wardby sends it as
`reasoning.effort`. An empty `efforts` means no reasoning parameter is sent,
and an agent with no `effort` gets OpenAI's default. The shipped reasoning
models (`gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`) list
`low`, `medium`, `high`, `xhigh`, and `max`; the older models (`gpt-4o`,
`gpt-4o-mini`, the `gpt-4.1` family) list none. OpenAI reasoning models reject
sampling parameters such as `temperature`; wardby doesn't send them. Requests
are sent with `store: false`, so OpenAI doesn't store the responses for later
retrieval. Reasoning tokens are billed as output tokens. They don't stream, so
a call's reasoning is charged when the call ends, and one call can take a run
past its budget by that call's reasoning; higher effort levels raise that
ceiling. The pre-turn input estimate and the budget group's run reservation
still apply. OpenAI cache-write tokens are billed at the catalog's
`cacheWritePerMTok`.

Setting the wrong `thinkingMode` (or listing `efforts` a model doesn't
actually accept) does not fail at `set_model` time — it fails when a coding
run actually calls the model, with `unsupported_anthropic_feature`. Check the
model's own documentation for which mode and effort levels it supports before
adding it.

For Claude Code coding runs, `efforts` is also exactly the set of effort levels
the coding proxy lets a run send for that model; any other level is refused
with `unsupported_anthropic_feature`. Always include the model's default level
(Claude Code sends the default unless told otherwise; most Claude models default
to `high`, some to `medium`), or every coding run on the model is refused.

A newly released Claude model can also require a newer Claude Code than the
one built into your Claude Code worker image. The provider then refuses the
coding run's requests, and the run fails with the `provider_rejected` category
at no cost; native runs on the same model are unaffected. Upgrade wardby (each
release pins a tested Claude Code version), rebuild your worker images, and
redeploy before pointing Claude Code agents at the new model.

## Google Gemini

Native agents can run Gemini 4 models through two providers. Coding agents
cannot use Gemini models.

| Provider                                  | Credentials                                                                                                   | Model ids                                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `vertex-gemini` (Vertex AI)               | `VERTEX_PROJECT` (or `GOOGLE_CLOUD_PROJECT`) and Application Default Credentials with `roles/aiplatform.user` | `gemini-4-neon`, `gemini-4-hydrogen`, `gemini-4-carbon` (global endpoint); prefix `us.` or `eu.` for the US or EU multi-region endpoint |
| `google-ai-studio` (Gemini Developer API) | `GEMINI_API_KEY`                                                                                              | `google-ai-studio.gemini-4-neon`, `google-ai-studio.gemini-4-hydrogen`, `google-ai-studio.gemini-4-carbon`                              |

Either or both can be configured; `list_models` marks the entries this
deployment can route to as `routable`.

**Vertex AI.** Enable the Vertex AI API (`aiplatform.googleapis.com`) on the
project, set `VERTEX_PROJECT`, and give the identity the server runs as
`roles/aiplatform.user`. Wardby uses Application Default Credentials: a
service account on Google Cloud (Workload Identity on GKE), or
`gcloud auth application-default login` for local use. The `us.` and `eu.`
ids keep requests inside that multi-region and cost more than the global ids;
each id carries its own rates in the catalog.

**Google AI Studio.** Set `GEMINI_API_KEY` to an AI Studio API key.

**Effort.** Neon and Hydrogen list `low`, `medium`, `high` and `xhigh`; Carbon
lists `low`, `medium` and `high`. Thinking is billed as output and, as with
OpenAI reasoning, is charged when each call ends, so a call can take a run
past its budget by its thinking.

**Worker image.** A Gemini tool call carries a thought signature the model
needs back on the next turn. A native sandbox worker image older than the
release that added Gemini silently drops it: the turn's tool calls still run,
side effects included, and the next model call then fails with
`Gemini API error: HTTP 400 INVALID_ARGUMENT: Function call is missing a thought_signature in functionCall parts`.
Use the worker image from the release that added Gemini, or a later one,
before pointing sandbox-mode agents at a Gemini model.

**Errors.** A non-200 response ends the call with
`Gemini API error: HTTP <status> <GOOGLE_STATUS>: <message>`. A `403
PERMISSION_DENIED` on Vertex means the identity wardby runs as (its service account) lacks `roles/aiplatform.user`
or the API is not enabled. `vertex_auth_unavailable` means no Google Cloud
credentials could be found. A `402 RESOURCE_EXHAUSTED` from AI Studio means
the project is out of prepaid credit.

Where each deployment target takes the credentials:

- GKE (`deploy/gke`): put `GEMINI_API_KEY` in `.env.local` before running
  `up.sh` (seeded as the optional Secret Manager entry `gemini-api-key`), and/or
  set `vertex_ai_enabled = true` in `terraform.tfvars`.
- Helm: put `GEMINI_API_KEY` in a Secret named `wardby-gemini-env`, loaded by
  `controlPlane.extraEnvFrom` and `nativeGateway.extraEnvFrom`; set
  `models.vertexProject` for Vertex. Do not put it in `models.providerSecret`,
  which also reaches the coding proxy.
- Google Cloud Run (`deploy/gcp`): set `gemini_api_key_value`, and/or set
  `vertex_ai_enabled = true` in `terraform.tfvars`. That enables the Vertex AI
  API, grants the Cloud Run service's service account `roles/aiplatform.user`,
  and sets `VERTEX_PROJECT` on the service.
- Local kind cluster (`deploy/kind-coding`): only `GEMINI_API_KEY` (AI Studio)
  is wired, from `.env.local`. Vertex needs Google Cloud credentials in the
  control plane and the native gateway, which the kind setup does not provide.

## Disabling and resetting

`disable_model` removes a model from routing without deleting its pricing
history: it keeps a disabled row under the model's own provider, so no other
provider can claim that id. For a non-shipped id, only `reset_model` frees
it; for a shipped id, nothing ever does, since the shipped provider owns the
id regardless of whether an override row exists. A disabled model
still appears in `list_models` with `includeDisabled: true` and in
`get_model`, but `routable` is no longer meaningful for it and new runs
cannot select it.

`reset_model` removes every catalog row for a model id, reverting it to the
shipped entry (if the release ships one) or removing it from the catalog
entirely.

Disabling or resetting a model never changes a run already in progress — see
"How a run is billed" below. It does change what a _new_ run can select:
an agent whose `model` is disabled, or removed by `reset_model` with no
shipped fallback, fails to start a new run with `model_unavailable` (see
[model-unavailable](../help/errors/model-unavailable.md)), and
`create_agent`/`update_agent` refuse to set or change an agent's model to
one that is unavailable.

Either way the run is recorded: it ends with status `failed`, zero spend, and
the `model_unavailable` message as its error, visible in `list_runs` and
`get_run`. A coding agent's run fails this way at dispatch, before a worker
starts — including when its model now belongs to a provider its coding
provider cannot drive (`Model "<id>" is not supported by coding provider
"<provider>"`). A scheduled agent still advances to its next window, rather
than retrying the same one, and `trigger_agent` returns the failed status and
its error straight away.

## When changes take effect

Each wardby process (the MCP server, the scheduler, `wardby run`) polls the
catalog on an interval set by `WARDBY_MODEL_CATALOG_REFRESH_SECONDS` (default
`45`). The process that handled a `set_model`, `disable_model` or
`reset_model` write refreshes its own catalog immediately after the write, so
that process's own routing sees the change right away; other processes pick
it up on their next poll, at most `WARDBY_MODEL_CATALOG_REFRESH_SECONDS`
later.

Every wardby process fails to start if it cannot read the catalog from the
database — it never silently falls back to running on the shipped catalog
alone, which would quietly re-enable a model an admin had disabled.

## How a run is billed

A run is priced at the catalog entry recorded when it started, for its whole
life, including any resume after a crash or restart. A later `set_model`,
`disable_model`, or `reset_model` never changes the price of a run already
under way; it only affects runs that start after the change. The entry
wardby recorded is visible as the run's price version.

Coding runs record their catalog entry at dispatch time, and the coding proxy
prices usage from that recorded entry rather than looking the model up again
mid-run.

## Upgrades

A wardby release can change the shipped catalog — adjusting a shipped rate,
adding a model, or changing a model's `thinkingMode`. If your deployment has
overridden a shipped model with `set_model`, your override continues to
shadow the shipped entry after the upgrade; it does not pick up the new
shipped values automatically. `list_models`/`get_model`'s `shippedDiffers`
field tells you when your override and the current shipped entry disagree,
so you can decide whether to `reset_model` back to the shipped values or
leave your override in place.

This matters when a release changes `efforts`: a database override replaces
the shipped entry wholesale, so an override of an OpenAI reasoning model
created before the release keeps its stored `efforts` (typically empty).
While it does, `create_agent` and `update_agent` reject any `effort` for that
model, and an existing agent's effort is not sent. Run `reset_model` on the id,
or `set_model` again with the new `efforts`, to pick up the shipped levels.
