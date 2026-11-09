# wardby-runs: a Claude Code pane for wardby runs

A pane beside the chat in Claude Code that lists your wardby agent runs and
shows each run's details. It talks to the wardby MCP server your Claude Code
session already has, through `list_runs`, `list_agents`, `get_run`,
`get_run_steps` and `get_run_transcript`, so it shows exactly what those tools
show you.

- Runs grouped by pull request (opened, review, fix rounds, sub-agent runs), as
  a ledger (each run with a status pill, its spend against its budget and a
  thin budget bar) or as one strip of steps per pull request.
- A run's request, final answer, outcomes, services, errors and run tree, each
  in its own card, with a **Copy** button on the desktop.
- A running run's recent steps, a finished run's steps, and each run's last
  step in the list. From 0.9.0, a step with detail (marked ▸) expands: click it on the desktop; in the
  terminal, `j`/`k` move between such steps and `e` shows or hides one. Detail
  appears only for the agent's owner and the run's starter (and the stdio
  operator), on a server at the detail level.
- Continue a finished Claude Code run in your own terminal with
  `wardby resume`.
- Filters, adaptive refreshing, and a toast when a run finishes.

## Install

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
