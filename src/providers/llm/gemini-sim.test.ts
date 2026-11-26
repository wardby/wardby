/**
 * The real Google AI Studio adapter against the simulator's scripted Gemini model (a loopback HTTP
 * server wrapping ScriptedModel): the thought signature the model sends on a function call must be
 * replayed on the next turn, and the model refuses (400 INVALID_ARGUMENT) a replay without it.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ScriptedModel } from "../../../tools/wardby-sim/src/model/script.js";
import { SHIPPED_CATALOG } from "./catalog-shipped.js";
import { GoogleAiStudioLlmProvider } from "./google-ai-studio.js";
import type { LlmMessage, LlmStreamEvent } from "./types.js";

const entry = SHIPPED_CATALOG.find((e) => e.modelId === "google-ai-studio.gemini-4-neon")!;
const model = new ScriptedModel();
let server: Server;
let provider: GoogleAiStudioLlmProvider;

beforeAll(async () => {
  model.load([
    {
      agent: "native-gemini",
      protocol: "gemini-generate-content",
      match: "[sim:gemini]",
      turns: [
        { parts: [{ functionCall: { id: "call_1", name: "lookup", args: { q: "x" } } }] },
        { parts: [{ text: "all done" }] },
      ],
    },
  ]);
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const result = model.answerGemini(Buffer.concat(chunks).toString("utf8"));
      if (result === null) res.writeHead(501).end("{}");
      else if (typeof result === "object") {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({
            error: { code: 400, status: "INVALID_ARGUMENT", message: "Function call is missing a thought_signature." },
          }),
        );
      } else res.writeHead(200, { "content-type": "text/event-stream" }).end(result);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/model/gemini/v1beta`;
  provider = new GoogleAiStudioLlmProvider("fake-key", { fetch: globalThis.fetch, baseUrl }).withEntry(entry);
});
afterAll(() => {
  server.close();
});

async function collect(messages: LlmMessage[]): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const e of provider.stream({ model: entry.modelId, messages })) events.push(e);
  return events;
}

describe("Gemini adapter against the scripted model", () => {
  it("replays the thought signature so turn 2 succeeds, and fails without it", async () => {
    const first: LlmMessage[] = [{ role: "user", content: "[sim:gemini] do it" }];
    const turn1 = await collect(first);
    const call = turn1.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ type: "tool_call", name: "lookup", providerData: "sim-sig-1-0" });
    if (call?.type !== "tool_call") throw new Error("no tool call");

    const followUp = (providerData?: string): LlmMessage[] => [
      ...first,
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: call.id, name: call.name, argsJson: call.argsJson, providerData }],
      },
      { role: "tool", content: "{}", toolCallId: call.id, name: call.name },
    ];

    const turn2 = await collect(followUp(call.providerData));
    expect(
      turn2
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join(""),
    ).toBe("all done");

    await expect(collect(followUp(undefined))).rejects.toThrow(/HTTP 400 INVALID_ARGUMENT/);
  });
});
