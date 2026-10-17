---
id: knowledge
title: Architecture knowledge bundles
summary: Keep cited, non-obvious architecture knowledge in docs/knowledge/ (or a folder you pick in .wardby/knowledge.yaml) so coding runs, reviewers, and live sessions (through the AGENTS.md pointer) use it; validate it with wardby knowledge check.
audience: operator
tags: [knowledge, architecture, coding-agents, okf, cli, drift, push, knowledge.yaml, bundle-path]
appliesTo: >=0.4.0
---

# Architecture knowledge bundles

A knowledge bundle is a set of markdown files in `docs/knowledge/` that records
architecture knowledge people tend to miss: pitfalls, invariants, decisions and
their reasons, and cross-module contracts. It uses the Open Knowledge Format
(OKF) v0.2 plus a `wardby:` front-matter block that lists the roles a concept is
for, the paths it affects, and citations to the code it describes. Each citation
carries a commit `sha` and a `spanHash` so staleness can be detected.

- `index.md` lists every concept in one line; `log.md` records changes to the
  bundle.
- **Pick your own folder:** add `.wardby/knowledge.yaml` with one line,
  `path: .okf` (any repo-relative folder outside `.wardby/` and `.git/`). Wardby
  then reads the bundle there for the coding-run note, merge-watcher drift runs,
  and `wardby knowledge check`. Without the file it uses `docs/knowledge/`; an
  invalid file is ignored with a warning (`knowledge_config_invalid` from the
  check). Or skip wardby's reading entirely: tell your agents where knowledge
  lives in their prompts or `AGENTS.md`, and they use that folder; you lose
  only the automatic note and drift scoping on merge. Update any prompt that
  names `docs/knowledge/` to your folder.
- When the bundle's `index.md` exists on a coding run's base branch, the run's
  task includes the index automatically (up to 8 KiB). It never fails a
  dispatch; an unreadable index just means no note.
- When the run's commit is known (it always is for a normal clone) and the
  request leaves room, the task ends with a `Base commit: <sha>` line. The workspace
  has no git metadata, so use that value for citation `sha` fields.
- Validate the bundle with `wardby knowledge check` (add `--strict` to fail on
  warnings, `--json` for machine output, `--root` to point at the repository).
  Errors are `concept_invalid`, `concept_secret`, `index_missing`,
  `index_link_broken`, and `knowledge_config_invalid`; warnings are `concept_not_indexed`,
  `citation_unverifiable`, and `citation_stale`.
- Builders may edit concept prose. Citations can go stale afterward; the
  architecture agent re-anchors them.

To keep the bundle current on a schedule, set up the scheduled agent described
in [Set up an architecture agent](help://architecture-agent). Code-review agents can read the bundle too.

To re-verify only the concepts a merge touched, link a small watcher agent with
the `push` trigger; it starts the architecture agent when a merge to the default
branch affects a concept. See
[Keep the knowledge bundle current on merge](help://architecture-agent) and
[Connect GitHub repositories](help://github-integration) (the GitHub App must
subscribe to the Push event).

Read [`docs/knowledge.md`](../docs/knowledge.md) for the concept format, the
span-hash definition, a full example, the issue-code table, and the reviewer
prompt section.
