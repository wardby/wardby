---
id: gemini-models
title: Google Gemini models
summary: Run native agents on Gemini 4 models through Vertex AI or Google AI Studio.
audience: all
tags: [models, gemini, google, vertex, vertex-ai, ai-studio, neon, hydrogen, carbon, providers]
appliesTo: ">=0.11.0"
---

# Google Gemini models

Native agents can use Gemini 4 models through two providers. Coding agents
cannot use Gemini models.

| Provider                                  | Credentials                                                                                                   | Model ids                                                                                                                                 |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `vertex-gemini` (Vertex AI)               | `VERTEX_PROJECT` (or `GOOGLE_CLOUD_PROJECT`) and Application Default Credentials with `roles/aiplatform.user` | `gemini-4-neon`, `gemini-4-hydrogen`, `gemini-4-carbon` (global endpoint); `us.` or `eu.` in front for the US or EU multi-region endpoint |
| `google-ai-studio` (Gemini Developer API) | `GEMINI_API_KEY`                                                                                              | `google-ai-studio.gemini-4-neon`, `google-ai-studio.gemini-4-hydrogen`, `google-ai-studio.gemini-4-carbon`                                |

Both can be configured at once. `list_models` shows the ids this deployment can run.

## Effort

Neon and Hydrogen accept `low`, `medium`, `high` and `xhigh`; Carbon accepts
`low`, `medium` and `high`. Gemini 4 always thinks: leaving effort unset uses
Google's default. Thinking is billed as output and is charged when each model
call ends.

## Pricing

Vertex `us.` and `eu.` ids cost more than the global ones; the catalog carries
each endpoint's own rates. Use `get_model` to see them.

## Older native worker images

Gemini tool calls carry data the model needs back on the next turn. A native
sandbox worker image older than this release cannot carry it: Gemini agents
need the worker image that ships with this release.

## Errors

- `Gemini API error: HTTP 402 RESOURCE_EXHAUSTED` — the AI Studio project has
  run out of prepaid credit. Add credit in AI Studio's billing settings.
- `Gemini API error: HTTP 403 PERMISSION_DENIED` (Vertex) — the identity wardby runs as
  (its service account) lacks `roles/aiplatform.user`, or the Vertex AI API is not enabled on the project.
- `vertex_auth_unavailable` — wardby could not get Google Cloud credentials. Check
  Workload Identity on GKE, or run `gcloud auth application-default login` locally.

Related: [Models and pricing](models.md), [Model not available](errors/model-unavailable.md).
