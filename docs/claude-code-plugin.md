# Claude Code plugin: the wardby runs pane

From Wardby 0.8.0, the `wardby-runs` Claude Code plugin shows your wardby agent
runs in a pane beside the chat. It lists runs grouped by pull request, shows a
run's request, outcomes, services, errors and final answer, and can continue a
finished Claude Code run in your own terminal.

The plugin lives in this repository under `plugins/claude-code/`, and the
repository is its marketplace (`.claude-plugin/marketplace.json`). It talks only
to the wardby MCP server your Claude Code session already has, through
`list_runs`, `list_agents`, `get_run`, `get_run_steps` and `get_run_transcript`,
so it shows exactly what those tools show you and needs no token of its own.

## Install

### With the wardby CLI

```sh
npx @wardby/cli@latest claude-plugin install
```

This installs the plugin from `wardby/wardby` and offers to allow the pane's
read-only tools for auto mode (see [Permissions](#permissions)). Options:

| Option                 | What it does                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--server-url <url>`   | Registers the wardby MCP server at this `https` URL (for example `https://wardby.example.com/mcp`) when Claude Code has none named `wardby`             |
| `--server-name <name>` | The MCP server the pane uses, as `/mcp` lists it (default `wardby`); the allow rules it adds follow the name, for example `mcp__wardby-prod__list_runs` |
| `--marketplace <src>`  | Installs from another marketplace: an operator's own repository (`your-org/claude-plugins`) or a local folder                                           |
| `--allow-tools`        | Allows the pane's read-only tools without asking; `--no-allow-tools` leaves permission rules alone                                                      |
| `--fullscreen`         | Also switches Claude Code's terminal to its fullscreen view (see [Terminal](#in-the-terminal)); it applies to every session                             |
| `--yes`                | Answers yes to every question                                                                                                                           |

`wardby quickstart` offers the same install once it has connected Claude Code
(`--claude-plugin` installs it without asking, `--no-claude-plugin` skips it),
and `wardby doctor` lists the plugin, the MCP server and the allow rules
alongside its other checks, without failing when the optional pane is missing.

`wardby claude-plugin status` reports whether the plugin, the MCP server and
the allow rules are in place. `wardby claude-plugin uninstall` removes the
plugin and only the settings install added: the rules it added and the
fullscreen view if it switched it on. It leaves the MCP server in place.

The CLI writes to the settings file of the Claude Code it finds:
`$CLAUDE_CONFIG_DIR/settings.json`, else `~/.claude/settings.json`. It refuses a
settings file that isn't valid JSON instead of overwriting it.

### In Claude Code

At the prompt of a terminal session:

```
/plugin install wardby-runs --marketplace wardby/wardby
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt
box, then **Plugins**, **Add marketplace** with `wardby/wardby`, then **Add
plugin**. A plugin installed from a terminal at user scope also loads in the
desktop app's local Code sessions that read the same Claude Code configuration.

Open the pane with `/wardby-runs`; `/wardby-runs close` closes it and
`/wardby-runs clear` clears its filters.

### The MCP server

The pane needs an MCP server named `wardby` in Claude Code. `wardby quickstart`
registers one; for a deployed instance, add it with `--server-url` above or:

```sh
claude mcp add --transport http --scope user wardby https://wardby.example.com/mcp
```

then sign in with `/mcp`. Another name works too: set the plugin's **wardby MCP
server** option to it. A server added through the Claude apps' **Connectors**
settings is not a Claude Code MCP server and the pane doesn't use it. With another
name, install with `--server-name <name>` so the allow rules match it, and the
pane's own hints name it too.

## Permissions

The pane reads only, with the caller's own access:

| Pane feature         | MCP tool             | Scope         | What you see                                                                   |
| -------------------- | -------------------- | ------------- | ------------------------------------------------------------------------------ |
| Run list             | `list_runs`          | `agents:read` | All runs of agents you own, and the runs you started on agents shared with you |
| Agent names, budgets | `list_agents`        | `agents:read` | Agents you can see (the pane asks for `summary: true`)                         |
| Run detail           | `get_run`            | `agents:read` | Runs you started, or of agents you own                                         |
| Recent steps, Steps  | `get_run_steps`      | `agents:read` | Same as `get_run`                                                              |
| Continue locally     | `get_run_transcript` | `agents:read` | Same as `get_run`                                                              |

Under Claude Code's auto mode, a plugin's MCP calls go through the same safety
check as any other, and calls the pane makes on its own timer are refused
unless allowed. Allow these in `/permissions` (or let `wardby claude-plugin
install` add them): `mcp__wardby__list_runs`, `mcp__wardby__list_agents`,
`mcp__wardby__get_run`, `mcp__wardby__get_run_transcript` and
`mcp__wardby__get_run_steps`. The pane never calls `stop_run` or any other tool
that changes something. When a call is refused, the pane says which rules to
add.

Plugins are not sandboxed: they run as you. **Continue locally** runs
`npx @wardby/cli@latest resume - --print` in the folder you give it, passing the
transcript's download link on standard input; the link is never drawn, stored
or logged. The import writes only under `~/.wardby/` and the new worktree.

## Using the pane

- **Ledger** (desktop): runs grouped by pull request (or Jira issue), each group
  one row with its state and total cost, folded once every run in it finished.
  A pull request with one run is one line. Runs that touch no pull request are
  under **Other**. The newest run comes first: groups (Other too) are ordered by
  their newest run, and so are the runs in a group. Each line names its step (opened, review, fix 1, …), with
  sub-agent runs under their lead, and shows the run's status as a coloured
  pill, its spend as "$x of $y", what started it, its task and how long it
  ran, over a thin budget bar.
- **Strips** (desktop): one card per pull request, its steps drawn as a row of
  dots; click a step's name to see it.
- **Filters**: show all, active, failed or finished runs, or type to match an
  agent, status, trigger or task.
- **Run detail**: a header with the run's status, short id, repository, model,
  duration and budget bar, then a card each for what started the run (with its
  request), what it produced, the run tree, services (ready, starting or
  failed), steps, the final answer and **Continue locally** for finished Claude
  Code runs with `sessionResume` on (see [Resume Claude Code runs locally](coding-agent-setup.md#resume-a-run-locally)).
  Each kind of card has its own colour, the same on every run: a thin bar
  along its top on the desktop, its rounded border in the terminal.
  The request and final answer show about three lines, as markdown, then how
  many more; **Show full text** shows all of it. The pull request link and the
  other actions sit at the bottom.
- **Copy**: on the desktop, each card (and an error, and an open step's detail)
  has a **Copy** button that copies its full text as the server sent it. In the
  terminal, **Copy section** (`y`) copies the open step's detail; **Copy run
  id** is on both.
- **Recent steps** (a running run's detail): its last 8 steps, refreshed with
  the run. A tool step is one row: its result at the left (✓ when it passed,
  the exit code of a failed command, or ! for an error), then the tool and its
  command or file; on the desktop a long command is cut with "…". What the
  model said wraps to about two lines.
- **Steps** (a finished run's detail): every recorded step, 200 at a time;
  **More steps** loads the next 200.
- **Step detail**: From 0.9.0, a step with detail, or a longer message, has a
  ▸ at its right that opens it (▾ closes it); in the terminal, `j`/`k` also
  move between such steps and `e` shows or hides one. One step is open at a
  time. An open command shows "$ command", its exit status and its output;
  Codex's framing lines (chunk id, wall time, token count) are left out, and
  **Copy** still copies the detail exactly as stored. Detail appears only for
  the agent's owner and the run's starter (and the stdio operator), on a
  server at the detail level. An open detail shows its last 40 lines, with a
  count of the lines above them.
- **Last step**: in the list, a running or failed run shows its newest step
  under the agent's name.

Steps come from the server's run steps (see
[Run steps](debugging-agent-runs.md#run-steps)): they need a server that has
`get_run_steps` and records steps (Wardby 0.9.0 or later). Against an older
server the pane shows no steps and checks again every few refreshes. When the
server has steps off (`WARDBY_RUN_STEPS=off`) the detail says "Steps are off on
this server." A run with no recorded steps shows none. If you installed the pane
before run steps, run `wardby claude-plugin install` again (or allow
`mcp__wardby__get_run_steps` in `/permissions`): under auto mode the pane
otherwise shows which rule to add in place of the steps. `wardby claude-plugin
status` and `wardby doctor` name the missing rule.

The pane refreshes every 10 seconds while a run is active and every 60 seconds
otherwise (the plugin's **pollSeconds** and **idleSeconds** options), asks only
for what changed since its last refresh, backs off when the server fails, and
polls only while it is open.

### In the terminal

Claude Code's classic terminal view draws a plugin pane as a band above the
prompt and doesn't pass mouse clicks to plugins: use the keyboard (ctrl+x tab
focuses the pane, then `1`–`9` open a run, `r` refreshes, `b` goes back, `m`
shows full text, `y` copies an open step's detail, `x` or Escape closes). In the fullscreen view the pane is a side bar beside the chat
and takes clicks. Turn it on with `"tui": "fullscreen"` in your Claude Code
settings (or `--fullscreen` above, or `CLAUDE_CODE_NO_FLICKER=1`), then restart
Claude Code. The desktop app needs none of this.

## Add it to your own marketplace

The plugin keeps everything it needs in `plugins/claude-code/` and has no
instance-specific values, so an operator can list it in their organization's
marketplace. Point an entry at this repository's subfolder, pinned to a
release:

```json
{
  "name": "wardby-runs",
  "source": {
    "source": "git-subdir",
    "url": "wardby/wardby",
    "path": "plugins/claude-code",
    "ref": "v0.8.0"
  }
}
```

Preset its options for your users in managed settings under
`pluginConfigs["wardby-runs@<your marketplace>"].options` (for example the MCP
server's name), and ship the allow rules above in the same managed settings.
When managed settings set `allowManagedHooksOnly`, a plugin a user installs
loads no hooks: install it through managed settings instead.

## Limits

- Plugins draw in the Claude Code terminal, the desktop app's Code tab and VS
  Code; not in claude.ai/code, `claude -p`, the Agent SDK or WSL.
- The pane polls; there is no push.
- A run's live steps and a readable transcript are not shown yet.
