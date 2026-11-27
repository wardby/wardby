import { describe, expect, it } from "vitest";
import { readSubAgentsSetting, SUB_AGENTS_ENV } from "./run-settings.js";

describe("readSubAgentsSetting", () => {
  it("reads true/false, falls back when unset, and refuses anything else with the safe code", () => {
    expect(readSubAgentsSetting({ [SUB_AGENTS_ENV]: "true" }, false)).toBe(true);
    expect(readSubAgentsSetting({ [SUB_AGENTS_ENV]: "false" }, true)).toBe(false);
    expect(readSubAgentsSetting({}, false)).toBe(false);
    expect(readSubAgentsSetting({}, true)).toBe(true);
    expect(() => readSubAgentsSetting({ [SUB_AGENTS_ENV]: "yes" }, false)).toThrow("worker_run_settings_invalid");
  });
});
