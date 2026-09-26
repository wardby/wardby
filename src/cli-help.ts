export const CLI_USAGE = `usage:
  wardby quickstart [--provider openai|anthropic] [--model <m>] [--budget <usd>] [--client none|codex|claude|both] [--skip-demo] [--non-interactive --yes]
  wardby doctor
  wardby status
  wardby logs [--tail N] [--follow]
  wardby down [--volumes]
  wardby agent create --name <n> --model <m> --prompt <p> --budget <usd> [--schedule "<cron>"] [--timezone <tz>] [--max-turns <n>] [--owner <subject>] [--public]
      (owned by --owner or LOCAL_PRINCIPAL; --public shares it with everyone at execute)
  wardby agent list
  wardby agent schedule <name> --cron "<expr>" [--timezone <tz>] [--disable]
  wardby tool create --name <n> --description <d> --params <file> --code <file>
  wardby tool attach <tool-name|tool-id> <agent-name>   (grants the capabilities in the agent owner's name)
  wardby tool detach <tool-name|tool-id> <agent-name>
  wardby tool update <tool-name|tool-id> [--description <d>] [--params <file>] [--code <file>]
  wardby tool delete <tool-name|tool-id> [--detach]
  wardby tool list [--agent <name>]
  wardby run <name>
  wardby runs [--agent <name>] [--limit N] [--status <s>]
  wardby coding preflight   (JOB_LAUNCHER=docker or kubernetes)
  wardby coding cleanup --run-id <id>
  wardby scheduler [--scope default]
  wardby mcp   (MCP_TRANSPORT=stdio|http selects the transport)
  wardby serve [--scope default]   (mcp + scheduler + reconciler in one process; http only)
  wardby grants migration-report [--json]
  wardby grants adopt-public --owner <subject> [--dry-run]
  wardby grants prune-bindings [--dry-run]
  wardby import <bundle-dir> [--owner <subject>] [--public] [--include-secrets --transfer-key <pem>] [--default-budget <usd>] [--dry-run] [--prefix <p>] [--on-conflict fail|skip|rename] [--allow-open-fetch]

options:
  -h, --help       Show this help
  -v, --version    Show the installed Wardby version`;
