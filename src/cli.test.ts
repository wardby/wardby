/**
 * `wardby scheduler` is a long-running process that dispatches scheduled coding runs through its
 * own Kubernetes-backed executor (built directly in `scheduler()`, not via `startMcp`), so its first
 * scheduled run would otherwise still pay the lazy cluster-preflight cost `warmUp` exists to avoid.
 *
 * `cli.ts` can't safely be imported in a test: `main()` runs unconditionally at module scope (it is
 * always dynamically `import()`-ed exactly once, by `wardby-bin.ts`, as the real CLI entry point) and
 * would dispatch on vitest's own `process.argv` and call `process.exit`. This guards the warm-up
 * wiring at the source level instead — the same technique
 * `providers/coding-proxy/mock-upstream-deploy-guard.test.ts` uses for deploy manifests it can't
 * safely execute either.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "cli.ts"), "utf8");

function functionBody(name: string): string {
  const start = SOURCE.indexOf(`async function ${name}(`);
  expect(start, `function ${name} not found in cli.ts`).toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf("\n}\n", start);
  expect(end, `end of function ${name} not found in cli.ts`).toBeGreaterThan(start);
  return SOURCE.slice(start, end);
}

describe("cli.ts warm-up wiring", () => {
  it("imports warmUpExecutor from the same module startMcp uses, not a duplicate implementation", () => {
    expect(SOURCE).toMatch(/import\s*\{[^}]*\bwarmUpExecutor\b[^}]*\}\s*from\s*"\.\/mcp\/index\.js"/);
  });

  it("wardby scheduler calls the shared warmUpExecutor helper right after launch", () => {
    const body = functionBody("scheduler");
    expect(body).toContain("await executor.launch?.();");
    expect(body).toContain("warmUpExecutor(executor);");
    // Same ordering as startMcp's call site: warm-up starts only after launch has completed.
    expect(body.indexOf("warmUpExecutor(executor);")).toBeGreaterThan(body.indexOf("await executor.launch?.();"));
  });

  it("wardby run and coding preflight never call warmUpExecutor (one-shot paths)", () => {
    const run = functionBody("run");
    const coding = functionBody("codingOps");
    expect(run).not.toContain("warmUpExecutor");
    expect(coding).not.toContain("warmUpExecutor");
  });
});

describe("cli.ts wardby tool attach", () => {
  it("refuses a coding agent's native tool with the same shared check MCP attach_tool and the importer use, before attaching", () => {
    const body = functionBody("toolAttach");
    expect(SOURCE).toMatch(/import\s*\{[^}]*\bcodingAgentAttachProblem\b[^}]*\}\s*from\s*"\.\/core\/tool-names\.js"/);
    expect(body).toContain("const codingProblem = await codingAgentAttachProblem(prisma, agent.id, tool);");
    expect(body).toContain("if (codingProblem) fail(codingProblem);");
    expect(body.indexOf("codingAgentAttachProblem(")).toBeLessThan(body.indexOf("prisma.agentTool.upsert("));
  });
});
