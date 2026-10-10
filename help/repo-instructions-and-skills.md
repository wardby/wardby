---
id: repo-instructions-and-skills
title: Repository instructions and skills in coding runs
summary: What AGENTS.md, CLAUDE.md, and repo skills a coding run loads, and how to turn repo skills off per agent with codingProfile.repoSkills.
audience: all
tags: [coding, skills, repoSkills, claudeBareMode, CLAUDE.md, AGENTS.md, SKILL.md, codex, claude-code]
appliesTo: ">=0.5.4"
---

# Repository instructions and skills in coding runs

Every coding run loads the repository's own instructions, and by default
also loads whatever agent skills the repository ships. This is on for both
builders and cannot be turned off for instructions; skills can be turned off
per agent.

## Repository instructions (always on)

| Builder     | Gets                                                                              |
| ----------- | --------------------------------------------------------------------------------- |
| Codex       | `AGENTS.md`, read directly from the checkout                                      |
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md`, and their `@path` imports (up to 5 levels deep) |

A repository that only has `AGENTS.md` still gets it in Claude Code, through
a one-line `CLAUDE.md` wardby synthesizes for it. Subdirectory `CLAUDE.md`
files (anything other than the repository root and `.claude/CLAUDE.md`) are
not loaded unless an imported file pulls them in.

Claude Code's instructions and skills are bounded: at most 64 KiB per file,
200 files, and 256 KiB combined; symlinks and non-UTF-8 files are refused. A
file that doesn't pass is left out of the run rather than failing it.
Repository settings, hooks, `.mcp.json`, agents, and commands are never sent
to Claude Code — only Markdown instruction files and
`.claude/skills/<name>/SKILL.md` files are allowed through, whatever an
instruction file imports.

Repository instructions and skills are untrusted guidance: they can shape a
run's work but never relax the worker's sandbox rules.

## Repository skills

`codingProfile.repoSkills` loads the repository's own agent skills into a
run. It defaults to `true`, and the agent owner or an admin can set it with
`create_agent`/`update_agent`:

```json
{ "id": "<agent-id>", "codingProfile": { "repoSkills": false } }
```

| Builder     | Reads skills from                   | `repoSkills: false`                |
| ----------- | ----------------------------------- | ---------------------------------- |
| Codex       | `.agents/skills/`, `.codex/skills/` | Every repository skill is disabled |
| Claude Code | `.claude/skills/<name>/SKILL.md`    | No skill context is collected      |

Codex's own four built-in skills (`imagegen`, `openai-docs`, `skill-creator`,
`skill-installer`) are always disabled, whatever `repoSkills` is set to.

A Claude Code skill ships to the worker as its `SKILL.md` only; its other
files (scripts, references, data) stay in the repository checkout, read or
run through the command runner at `/workspace/.claude/skills/<name>/`.

## Claude Code loading mode

`codingProfile.claudeBareMode` (Claude Code agents only, default `true`)
decides how Claude Code uses its repository instructions and skills:

- **`true` (default).** Claude Code's hardened bare mode stays on. Wardby
  adds the repository's instruction files to the system prompt in full, and
  lists each skill by name, description, and path; the model reads a
  skill's full `SKILL.md` itself with `run_command`.
- **`false`.** Bare mode is off and Claude Code loads `CLAUDE.md` and skills
  itself, through its native Skill tool, instead of reading them from the
  system prompt.

Repository settings, hooks, MCP configuration, agents, and commands are
never loaded in either mode.

```json
{ "id": "<agent-id>", "codingProfile": { "claudeBareMode": false } }
```

## See also

- [Choose a native or coding agent](creating-agents.md) for `codingProfile`
  basics and the other fields it accepts.
- [Bring-Your-Own Coding-Worker Images](../docs/coding-worker-byo-images.md)
  — a Codex agent's `workerImageRef` image must be rebuilt on a current driver
  base to accept `repoSkills: false` and to stop offering Codex's built-in
  skills; on a Claude Code agent, `workerImageRef` must be this release's
  Claude Code worker image.
