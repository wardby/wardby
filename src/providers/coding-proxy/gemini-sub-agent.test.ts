import { describe, expect, it } from "vitest";
import { STEP_AGENT_REF } from "../../core/run-steps/types.js";
import { geminiSubAgentRef, isGeminiSubAgentRequest } from "./gemini-sub-agent.js";

const decl = (...names: string[]) => [{ functionDeclarations: names.map((name) => ({ name })) }];
const main = {
  systemInstruction: { parts: [{ text: "You are an interactive CLI agent" }] },
  contents: [{ role: "user", parts: [{ text: "<session_context>\ncwd: /workspace\n</session_context>" }] }],
  tools: decl("read_file", "run_shell_command", "invoke_agent", "update_topic"),
  generationConfig: { maxOutputTokens: 32_000 },
};
const sub = {
  systemInstruction: { parts: [{ text: "You are an interactive CLI agent, as a sub-agent" }] },
  contents: [{ role: "user", parts: [{ text: "Count the lines of every file under src." }] }],
  tools: decl("read_file", "run_shell_command", "complete_task"),
  generationConfig: { maxOutputTokens: 32_000 },
};

describe("Gemini sub-agent recognition", () => {
  it("recognises a sub-agent request by complete_task and a first message without session context", () => {
    expect(isGeminiSubAgentRequest(sub)).toBe(true);
    expect(isGeminiSubAgentRequest(main)).toBe(false);
    // A main loop that somehow declared complete_task is still the main loop while it offers invoke_agent.
    expect(isGeminiSubAgentRequest({ ...main, tools: decl("invoke_agent", "complete_task") })).toBe(false);
    expect(isGeminiSubAgentRequest({ ...sub, contents: main.contents })).toBe(false);
    // Helper calls declare no functions.
    expect(isGeminiSubAgentRequest({ contents: sub.contents })).toBe(false);
  });

  it("labels a sub-agent's conversation with a stable, well-formed id", () => {
    const ref = geminiSubAgentRef(sub);
    expect(ref).toMatch(/^gemini-[A-Za-z0-9_-]{16}$/);
    expect(STEP_AGENT_REF.test(ref!)).toBe(true);
    expect(geminiSubAgentRef({ ...sub, contents: [...sub.contents, { role: "model", parts: [{ text: "x" }] }] })).toBe(
      ref,
    );
    expect(geminiSubAgentRef({ ...sub, contents: [{ role: "user", parts: [{ text: "Another task." }] }] })).not.toBe(
      ref,
    );
    expect(geminiSubAgentRef(main)).toBeUndefined();
  });
});
