// Live check of the real final-answer schema on Gemini 4 (AI Studio and Vertex). It spends real money
// (four short runs, each held to RUN_BUDGET_USD), so it runs only when WARDBY_GEMINI_LIVE_TEST=1 (and the
// Docker flag WARDBY_GEMINI_DOCKER_TEST=1) are set. Credentials reach the worker only through the proxy:
//   - AI Studio: GEMINI_API_KEY in this shell (read by name, never printed).
//   - Vertex: Application Default Credentials in this shell, plus CODING_VERTEX_PROJECT (the proxy's own
//     setting, src/config/coding-proxy-gemini.ts). The location comes from the model id (us.* -> us).
// The test prints only status, cost, cached share and pass/fail: never a key, token, prompt or reply.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERTEX_CREDENTIAL_REF } from "../providers/coding-proxy/gemini-upstream.js";
import { MemoryProxyLedger } from "../providers/coding-proxy/memory-ledger.js";
import { CodingProxy } from "../providers/coding-proxy/proxy.js";
import { startCodingProxyServer } from "../providers/coding-proxy/server.js";
import type { ProxyAuditEvent } from "../providers/coding-proxy/types.js";
import { shippedCatalog } from "../providers/llm/catalog.js";
import { entryOf } from "../providers/llm/catalog-types.js";
import { GEMINI_DOCKER_ENABLED, runWorker, taskInput } from "./docker.test-support.js";

const LIVE = GEMINI_DOCKER_ENABLED && process.env.WARDBY_GEMINI_LIVE_TEST === "1";
/** Per-run session budget: it must cover the first hold (the 32,000-token output cap plus the input estimate, about $0.75 on Neon); actual spend is asserted separately. */
const RUN_BUDGET_USD = 1.5;
/** What one short run may actually cost. */
const RUN_SPEND_LIMIT_USD = 0.4;
const MENTION_TASK =
  "Fix sum() so `node --test` passes. Run the tests. Also create notes.txt with one line: a comment mentioning @types/node and contact dev@example.com. Do not change anything else.";
const PLAIN_TASK = "Fix sum() so `node --test` passes. Run the tests. Do not change anything else.";

describe.skipIf(!LIVE)("live: the real final-answer schema on Gemini 4", () => {
  it.each([
    ["google-ai-studio.gemini-4-neon", false],
    ["google-ai-studio.gemini-4-neon", true],
    ["us.gemini-4-neon", false],
    ["us.gemini-4-neon", true],
  ])(
    "%s (multi-repo: %s)",
    async (model, multi) => {
      const entry = entryOf(shippedCatalog().require(model));
      const vertex = entry.provider === "vertex-gemini";
      if (!vertex && !process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in this shell");
      if (vertex && !process.env.CODING_VERTEX_PROJECT)
        throw new Error("CODING_VERTEX_PROJECT is not set in this shell");
      const audit: ProxyAuditEvent[] = [];
      const proxy = new CodingProxy({
        ledger: new MemoryProxyLedger(),
        credentials: {
          resolve: async (ref) => {
            if (ref !== "env:GEMINI_API_KEY") throw new Error("unexpected credential reference");
            return process.env.GEMINI_API_KEY!;
          },
        },
        audit: (event) => void audit.push(event),
        gemini: { vertexProject: process.env.CODING_VERTEX_PROJECT! },
      });
      const session = await proxy.createSession({
        runId: `gemini-live-${Date.now()}`,
        credentialRef: vertex ? VERTEX_CREDENTIAL_REF : "env:GEMINI_API_KEY",
        protocol: "gemini-generate-content",
        allowedModels: [model],
        deadlineAt: new Date(Date.now() + 900_000),
        budgetUsd: RUN_BUDGET_USD,
        terms: { version: "live", entry },
      });
      // The container reaches this host-side proxy through host.docker.internal.
      const server = await startCodingProxyServer(proxy, { host: "0.0.0.0", port: 0 });
      const dirs: string[] = [];
      try {
        const ws = await mkdtemp(join(tmpdir(), "wardby-gemini-live-"));
        dirs.push(ws);
        await writeFile(join(ws, "package.json"), '{ "type": "module" }\n');
        await writeFile(join(ws, "sum.js"), "export function sum(a, b) {\n  return a - b;\n}\n");
        await writeFile(
          join(ws, "sum.test.js"),
          'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.js";\ntest("adds", () => assert.equal(sum(2, 3), 5));\n',
        );
        let extra: string | undefined;
        if (multi) {
          extra = await mkdtemp(join(tmpdir(), "wardby-gemini-live-docs-"));
          dirs.push(extra);
          await mkdir(extra, { recursive: true });
          await writeFile(join(extra, "README.md"), "# docs\n");
        }
        // The @ forms go in the single-repo runs: the system note about "\@" must hold on the real model.
        const run = await runWorker({
          input: taskInput(model, {
            task: multi ? PLAIN_TASK : MENTION_TASK,
            budgetUsd: RUN_BUDGET_USD,
            ...(extra
              ? {
                  repositories: [
                    {
                      name: "docs",
                      path: "/repos/docs",
                      repository: "your-org/your-docs",
                      commit: "0".repeat(40),
                      access: "read" as const,
                    },
                  ],
                }
              : {}),
          }),
          workspace: ws,
          env: {
            WARDBY_PROXY_URL: `http://host.docker.internal:${server.port}`,
            WARDBY_RUN_CAPABILITY: session.capability,
          },
          ...(extra ? { extraArgs: ["-v", `${extra}:/repos/docs:ro`] } : {}),
        });
        // request.released: the upstream (Google) refused the request, e.g. a schema it cannot serve.
        const rejected = audit.filter((e) => e.type === "request.rejected" || e.type === "request.released");
        const completed = audit.filter((e) => e.type === "response.completed");
        const sum = (pick: (e: ProxyAuditEvent) => number | undefined) =>
          completed.reduce((total, e) => total + (pick(e) ?? 0), 0);
        const costUsd = sum((e) => e.costUsd);
        const inputTokens = sum((e) => e.inputTokens);
        const cachedShare = inputTokens > 0 ? sum((e) => e.cachedInputTokens) / inputTokens : 0;
        const statuses = [...new Set(audit.filter((e) => e.status !== undefined).map((e) => e.status))];
        const mention = multi ? undefined : await readFile(join(ws, "notes.txt"), "utf8").catch(() => "");
        const mentionOk =
          mention === undefined
            ? null
            : mention.includes("@types/node") && mention.includes("dev@example.com") && !mention.includes("\\@");
        console.log(
          JSON.stringify({
            model,
            multi,
            exit: run.exitCode,
            outcome: run.result?.outcome ?? null,
            rejected: rejected.length,
            statuses,
            requests: completed.length,
            costUsd: Number(costUsd.toFixed(4)),
            cachedShare: Number(cachedShare.toFixed(2)),
            mentionOk,
          }),
        );
        expect(rejected).toEqual([]);
        expect(run.result?.outcome).toBe("changes_ready");
        expect(costUsd).toBeLessThanOrEqual(RUN_SPEND_LIMIT_USD);
        if (mention !== undefined) {
          expect(mention).toContain("@types/node");
          expect(mention).toContain("dev@example.com");
          expect(mention).not.toContain("\\@");
        }
      } finally {
        await server.close();
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true }).catch(() => undefined)));
      }
    },
    900_000,
  );
});
