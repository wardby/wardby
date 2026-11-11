# wardby-runs: a Claude Code pane for wardby runs

A pane beside the chat in Claude Code that lists your wardby agent runs and
shows each run's details. It talks to the wardby MCP server your Claude Code
session already has, through `list_runs`, `list_agents`, `get_run`,
`get_run_steps`, `get_run_text` and `get_run_transcript`, so it shows exactly
what those tools show you.

- Runs grouped by pull request (opened, review, fix rounds, sub-agent runs), as
  a ledger (each run with a status pill, its spend against its budget and a
  thin budget bar) or as one strip of steps per pull request.
- A run's request, final answer, outcomes, services, errors and run tree, each
  in its own card (coloured by kind), with a **Copy** button on the desktop.
- A running run's recent steps, a finished run's steps, and each run's last
  step in the list: a ✓ or the exit code at the left, then the tool and its
  command. From 0.9.0, a step with detail has a ▸ at its right that opens it
  ("$ command", the exit status and the output); in the terminal, `j`/`k` move
  between such steps and `e` shows or hides one. Detail
  appears only for the agent's owner and the run's starter (and the stdio
  operator), on a server at the detail level.
- Continue a finished Claude Code run in your own terminal with
  `wardby resume`.
- Filters, adaptive refreshing, and a toast when a run finishes.

Against a server older than 0.8.0 the pane runs in a limited mode (each agent's
latest runs, no pull-request grouping, outcomes or run steps) and says so at the
top of the list.

## Install

The pane needs Claude Code 2.1.299 or later; on an older release
`/wardby-runs` says which version to update to.

The quickest way is the wardby CLI, which also offers the permission rules the
pane needs:

```sh
npx @wardby/cli@latest claude-plugin install
```

Or install it in Claude Code yourself:

```
/plugin install wardby-runs --marketplace wardby/wardby
```

Then open it with `/wardby-runs` (`/wardby-runs close` closes it).

See [the Claude Code plugin guide](../../docs/claude-code-plugin.md) for
permissions, the desktop app, the fullscreen terminal view and adding the
plugin to your own marketplace.

## Develop

The tests run against Claude Code's own plugin test kit:

```sh
claude plugin validate plugins/claude-code
claude plugin test plugins/claude-code
```
