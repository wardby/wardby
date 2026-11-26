---
id: models
title: Models and pricing
summary: Which models this deployment can run, what they cost, and how admins add, reprice, disable or reset them.
audience: all
tags: [models, pricing, list_models, set_model, disable_model, reset_model, get_model, models:admin, model-manager]
appliesTo: ">=0.4.0"
---

# Models and pricing

Wardby prices and routes every model call from one catalog: the models this
release ships, overlaid with this deployment's own additions and overrides.
An agent can use a model only when it's in the catalog and its provider has
credentials configured here.

## The five tools

| Tool            | Scope          | What it does                                                                              |
| --------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `list_models`   | `agents:read`  | Every active catalog entry (or, with `includeDisabled: true`, disabled ones too).         |
| `get_model`     | `agents:read`  | One entry by `modelId`; for an override, also the shipped entry it shadows.               |
| `set_model`     | `models:admin` | Adds or completely replaces one entry. Every field is required.                           |
| `disable_model` | `models:admin` | Removes a model from routing without deleting its pricing history.                        |
| `reset_model`   | `models:admin` | Removes every row for a model id, reverting to the shipped entry (if any) or removing it. |

Reading the catalog needs only `agents:read` — no secrets live in an entry.
Changing it needs `models:admin`, honored only for a caller whose Wardby role
grants it: `admin`, or the narrower `model-manager` role.

An entry's `origin` is `shipped` or `override`; `routable` says whether this
deployment can actually route to it right now; `shippedDiffers` (overrides of
a shipped model only) says whether your override has drifted from the
current shipped values. See [`docs/models.md`](../docs/models.md) for the
full field reference.

## Adding or overriding a model

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

The rates above are placeholders. Copy the provider's own published rates for
that exact model — including its cache read and cache write rates — from its
pricing page, and point `sourceUrl` at that page; never compute cache rates
from `inputPerMTok` with a multiplier.

`set_model` refuses (409) a `modelId` another provider already owns. A
shipped id always belongs to its shipped provider — permanently; no other
provider can ever claim it, not even by disabling or resetting the override.
A non-shipped id already claimed by another provider (its row active or
disabled) is freed only by `reset_model` — it takes only the `modelId` and
clears every row for it, whichever provider owns it; `disable_model` alone
never frees it, since the disabled row still reserves the id.

`thinkingMode` (`adaptive`, `manual`, or `none`) must match what the exact
model accepts. Getting it wrong doesn't fail at `set_model` — it fails later,
when a run calls the model, with `unsupported_anthropic_feature`.
For Claude Code coding runs, `efforts` is also the exact set of levels a run
may send, so always include the model's default effort level.

OpenAI models keep `thinkingMode` `none`; `efforts` alone drives
`reasoning.effort` on native agents, which call OpenAI's Responses API
(`store: false`). `gpt-5.6-sol`/`terra`/`luna` and `gpt-6-astra` list `low`
through `max`; `gpt-4o`, `gpt-4o-mini` and the `gpt-4.1` family list none.
Reasoning models reject sampling parameters such as `temperature`; wardby
doesn't send them. Reasoning tokens bill as output tokens, charged when the
call ends, so one call can take a run past its budget by its reasoning; higher
effort raises that ceiling.

After an upgrade, a `set_model` override of a shipped model keeps its stored
`efforts` (it replaces the shipped entry wholesale). If those are empty,
`create_agent`/`update_agent` reject an `effort` for the model: run
`reset_model`, or `set_model` again with the new efforts, to pick up shipped
changes.

A newly released Claude model may also need a newer Claude Code than your
Claude Code worker image has: coding runs on it then fail as
`provider_rejected` (no cost) while native runs work. Upgrade wardby and
rebuild the worker images before using the model in Claude Code agents.

Catalog changes take effect on the writing process immediately, and on every
other wardby process within `WARDBY_MODEL_CATALOG_REFRESH_SECONDS` (default
45). A run already in progress keeps the catalog entry it started with, so
disabling or repricing a model never changes a run already under way — only
new runs.

If this deployment delegates to an identity provider, define `models:admin`
there before relying on it, and map the `model-manager` role (or `admin`) to
the people who maintain pricing — see
[Configure identity and privileged access](identity-and-access.md).

Native agents can also run Google Gemini 4 models through Vertex AI or Google
AI Studio; read the `gemini-models` help article.

If a run can't use a model, see
[Model not available](errors/model-unavailable.md).
