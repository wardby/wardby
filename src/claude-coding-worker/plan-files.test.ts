import { describe, expect, it } from "vitest";
import { PLAN_FILES_LIMITS } from "../coding/protocol.js";
import { collectPlanFilesViaToolRunner } from "./plan-files.js";

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("collectPlanFilesViaToolRunner", () => {
  it("reads every listed path", async () => {
    const result = await collectPlanFilesViaToolRunner({
      list: async () => ({ ok: true, paths: ["plan.md"], skipped: [], skippedUnnamed: 0 }),
      read: async (path) => ({ ok: true, content_base64: b64(`# ${path}`) }),
    });
    expect(result).toEqual({
      status: "ok",
      files: [{ path: "plan.md", contentBase64: b64("# plan.md") }],
      skipped: [],
      skippedUnnamed: 0,
    });
  });

  it("passes plan_too_large through and refuses what the tool runner should never say", async () => {
    expect(
      await collectPlanFilesViaToolRunner({
        list: async () => ({ ok: false, reason: "plan_too_large" }),
        read: async () => null,
      }),
    ).toEqual({ status: "error", error: "plan_too_large" });
    expect(
      await collectPlanFilesViaToolRunner({
        list: async () => ({ ok: true, paths: ["../etc/passwd"], skipped: [], skippedUnnamed: 0 }),
        read: async () => ({ ok: true, content_base64: b64("x") }),
      }),
    ).toEqual({ status: "error", error: "plan_files_failed" });
    const big = Buffer.alloc(PLAN_FILES_LIMITS.maxFileBytes, 97).toString("base64");
    expect(
      await collectPlanFilesViaToolRunner({
        list: async () => ({
          ok: true,
          paths: Array.from({ length: 9 }, (_, i) => `f${i}.md`),
          skipped: [],
          skippedUnnamed: 0,
        }),
        read: async () => ({ ok: true, content_base64: big }),
      }),
    ).toEqual({ status: "error", error: "plan_too_large" });
  });

  it("a tool runner without the tools is plan_tool_unavailable", async () => {
    const result = await collectPlanFilesViaToolRunner({
      list: async () => {
        throw new Error("plan_tool_unavailable");
      },
      read: async () => null,
    });
    expect(result).toEqual({ status: "error", error: "plan_tool_unavailable" });
  });
});
