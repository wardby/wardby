# Runtime architecture — GitHub trigger path + observability

Two independent subsystems currently run side by side on the same host and
share only Postgres and a Docker Compose network: the `reevo mcp` process
(agents/runs/webhooks/MCP tools) and the observability stack shipped in
`feat: add local Prometheus and Grafana observability` (coding-proxy metrics
→ Prometheus → Grafana). Neither depends on the other; restarting one has no
effect on the other.

```mermaid
flowchart TB
    subgraph GH["GitHub — chfields/knock-knock-jokes"]
        Issue["Issue labeled 'ai-plan' /\n@knock-knock-delivery comment"]
        Action["Actions workflow:\nreevo-delivery-trigger.yml"]
        PRout["Draft PR opened"]
        Issue --> Action
    end

    Action -->|"POST /webhooks/:id\nx-webhook-secret"| Tunnel

    subgraph Public["Public HTTPS"]
        Tunnel["HTTPS tunnel (e.g. ngrok)\n<your-domain> -> :8080\n(TLS terminated here)"]
    end

    Tunnel --> MCP

    subgraph Host["Your machine"]
        subgraph MCPBox["reevo mcp (Node/tsx)\nMCP_TRANSPORT=http, self-hosted auth"]
            MCP["/webhooks/:id - secret auth\n/mcp - OAuth auth (list_agents, trigger_agent, get_run, ...)\n/.well-known/oauth-protected-resource"]
        end

        MCP -->|"creates Run, dispatches via JobLauncher"| Worker
        MCP <-->|"reads/writes"| PG[("local-postgres-1\nAgent, Run, Webhook,\nBudgetGroup, AgentMemory, Datastore")]

        subgraph Docker["Docker"]
            Worker["ephemeral coding worker\n(Codex / Claude Code)\none per Run"]
            Proxy["reevo-coding-proxy\ncredential injection +\ntoken/cost metering\n:9464/metrics (private net only)"]
            Worker -->|"OpenAI/Anthropic calls,\nproxied"| Proxy
            Proxy -->|"usage/cost ledger"| PG
        end

        Worker -->|"push branch"| PRout

        Proxy -->|"scraped"| Prom["local-prometheus-1\n127.0.0.1:9090 (loopback)\n24h retention"]
        Prom -->|"query"| Graf["local-grafana-1\n127.0.0.1:3000 (loopback)\ndashboards: reevo-coding-proxy,\nreevo-knock-knock"]
    end
```

## Key boundaries

- **Only one thing is reachable from outside this machine:** the HTTPS
  tunnel into `reevo mcp:8080`. Postgres, coding-proxy, Prometheus, and
  Grafana are all either fully private-network-only (`coding-proxy:9464`
  has no `ports:` mapping at all) or explicitly loopback-bound
  (`127.0.0.1:9090`, `127.0.0.1:3000`) — Grafana/Prometheus are not exposed
  through the tunnel.
- **The coding worker never sees real API credentials.** `reevo-coding-proxy`
  sits between it and OpenAI/Anthropic, injecting credentials and metering
  tokens/cost — this is also where `/metrics` lives.
- **Two write paths into Postgres:** `reevo mcp` owns the agent/run/webhook
  config tables directly; `coding-proxy` writes its own usage/cost ledger
  directly during a run, which `reevo mcp` reconciles back into the `Run`
  row once the container finishes (the "cap at the boundary, reconcile
  after" pattern for opaque agent runs).
- **`reevo mcp` restarts don't affect observability, and vice versa** —
  confirmed 2026-09-13: the `RunTrigger.webhook` fix required restarting
  `reevo mcp` only; the Prometheus/Grafana stack (PR #25) required
  rebuilding only the `coding-proxy` container, with no `reevo mcp` restart.
