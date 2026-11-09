import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentKind, CodingServiceState, RunStatus } from "#prisma";
import { GraphRunSchema, RunStatusSchema, ServiceStatusSchema, ViewerEventSchema } from "./api-schema.js";
import { renderSchemas, SCHEMA_DIR } from "./build-schemas.js";

describe("published viewer schemas", () => {
  it("are up to date (run `npm run build:viewer-schemas` and commit)", async () => {
    for (const [file, text] of Object.entries(renderSchemas())) {
      expect(await readFile(join(SCHEMA_DIR, file), "utf8"), file).toBe(text);
    }
  });
});

describe("viewer enums match the database enums", () => {
  const sorted = (values: readonly string[]) => [...values].sort();
  const serviceEvent = ViewerEventSchema.options.find((o) => o.shape.kind.value === "service")!;

  it("run status", () => {
    expect(sorted(RunStatusSchema.options)).toEqual(sorted(Object.values(RunStatus)));
  });

  it("coding-run service state (snapshot and event)", () => {
    expect(sorted(ServiceStatusSchema.shape.state.options)).toEqual(sorted(Object.values(CodingServiceState)));
    const eventState = serviceEvent.shape as unknown as { state: { options: string[] } };
    expect(sorted(eventState.state.options)).toEqual(sorted(Object.values(CodingServiceState)));
  });

  it("agent kind", () => {
    expect(sorted(GraphRunSchema.shape.agentKind.options)).toEqual(sorted(Object.values(AgentKind)));
  });
});

describe("outcome event source", () => {
  it.each(["pull_request", "host_status", "issue_status", "host_check"])("accepts %s", (source) => {
    expect(ViewerEventSchema.safeParse({ kind: "outcome", runId: "r", source }).success).toBe(true);
  });

  it("rejects an unknown source", () => {
    expect(ViewerEventSchema.safeParse({ kind: "outcome", runId: "r", source: "other" }).success).toBe(false);
  });
});

describe("step event", () => {
  const step = {
    kind: "step",
    runId: "r",
    seq: 3,
    stepKind: "tool",
    tool: "Bash",
    summary: "npm test",
    status: null,
    at: "2030-01-01T00:00:00.000Z",
  };
  it("accepts a recorded step and a said step", () => {
    expect(ViewerEventSchema.safeParse(step).success).toBe(true);
    expect(ViewerEventSchema.safeParse({ ...step, stepKind: "said", tool: null, status: null }).success).toBe(true);
  });
  it("rejects an unknown step kind", () => {
    expect(ViewerEventSchema.safeParse({ ...step, stepKind: "other" }).success).toBe(false);
  });
  it("never carries a call id or detail text", () => {
    const parsed = ViewerEventSchema.parse({ ...step, callId: "call_1", detail: "x" });
    expect(Object.keys(parsed).sort()).toEqual(["at", "kind", "runId", "seq", "status", "stepKind", "summary", "tool"]);
  });
});
