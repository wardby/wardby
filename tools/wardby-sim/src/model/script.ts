// TEST ONLY (wardby-sim). Scripted model mode: per-agent turn scripts replayed as model
// responses, $0 and deterministic, in the two wire protocols wardby's coding proxy and native
// gateway speak (OpenAI Responses, Anthropic Messages), always streamed.
//
// A script (tools/wardby-sim/scripts/flow-g/<agent>.<codex|claude>.json):
//   {
//     "agent": "builder",
//     "protocol": "openai-responses" | "anthropic-messages",
//     "match": "a substring every request of this agent carries (its prompt)",
//     "turns": [ { "items": [...] } | { "content": [...], "stop_reason": "tool_use" }, ... ]
//   }
// OpenAI turns carry Responses output items as the API sends them (message, function_call,
// custom_tool_call, reasoning); Anthropic turns carry content blocks (text, tool_use) and a stop
// reason. Each request of a matching agent takes the next turn; after the last, the last repeats.
//
// Templates in any string: {{runId}} (the coding worker's "The final JSON runId must be X."),
// {{last:<field>}} (the last value of a JSON string field named <field> anywhere in the request,
// e.g. a tool result's headSha), {{lastNumber:<field>}} for a number field.
export type ScriptProtocol = "openai-responses" | "anthropic-messages";

export interface ResponsesTurn {
  items: unknown[];
  usage?: Record<string, unknown>;
}
export interface MessagesTurn {
  content: ({ type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown })[];
  stop_reason?: "end_turn" | "tool_use" | "max_tokens";
  usage?: { input_tokens?: number; output_tokens?: number };
}
export interface TurnScript {
  agent: string;
  protocol: ScriptProtocol;
  match: string;
  turns: (ResponsesTurn | MessagesTurn)[];
}

const RUN_ID = /The final JSON runId must be ([A-Za-z0-9][A-Za-z0-9_-]*)\./;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Fills the templates of every string in `value` from the request body. */
export function fillTemplates(value: unknown, body: string): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(runId|last:[A-Za-z0-9_]+|lastNumber:[A-Za-z0-9_]+)\}\}/g, (_all, key: string) => {
      if (key === "runId") return RUN_ID.exec(body)?.[1] ?? "";
      const [kind, field] = key.split(":");
      // Tool results arrive JSON-encoded inside JSON strings, so quotes may be escaped.
      const pattern =
        kind === "last"
          ? new RegExp(`\\\\*"${escapeRegExp(field)}\\\\*"\\s*:\\s*\\\\*"([^"\\\\]*)`, "g")
          : new RegExp(`\\\\*"${escapeRegExp(field)}\\\\*"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`, "g");
      let found = "";
      for (const match of body.matchAll(pattern)) found = match[1];
      return found;
    });
  }
  if (Array.isArray(value)) return value.map((item) => fillTemplates(item, body));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplates(v, body)]));
  }
  return value;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

const RESPONSES_USAGE = {
  input_tokens: 1200,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 80,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 1280,
};

/** An OpenAI Responses stream: created, each item added/done, completed with usage. */
export function renderResponses(turn: ResponsesTurn, id: string, model: string): string {
  const usage = turn.usage ?? RESPONSES_USAGE;
  let out = sse("response.created", {
    type: "response.created",
    response: { id, model, status: "in_progress", output: [] },
  });
  turn.items.forEach((item, index) => {
    out += sse("response.output_item.added", { type: "response.output_item.added", output_index: index, item });
    out += sse("response.output_item.done", { type: "response.output_item.done", output_index: index, item });
  });
  out += sse("response.completed", {
    type: "response.completed",
    response: { id, model, status: "completed", output: turn.items, usage },
  });
  return out;
}

/** An Anthropic Messages stream: message_start, each block start/delta/stop, message_delta, message_stop. */
export function renderMessages(turn: MessagesTurn, id: string, model: string): string {
  const inputTokens = turn.usage?.input_tokens ?? 1200;
  const outputTokens = turn.usage?.output_tokens ?? 80;
  let out = sse("message_start", {
    type: "message_start",
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 1,
      },
    },
  });
  turn.content.forEach((block, index) => {
    if (block.type === "text") {
      out += sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      out += sse("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      out += sse("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    out += sse("content_block_stop", { type: "content_block_stop", index });
  });
  const stop = turn.stop_reason ?? (turn.content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn");
  out += sse("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  out += sse("message_stop", { type: "message_stop" });
  return out;
}

export interface ServedTurn {
  agent: string;
  protocol: ScriptProtocol;
  turn: number;
}

/** Holds the loaded scripts and each one's cursor. */
export class ScriptedModel {
  private scripts: TurnScript[] = [];
  private cursors = new Map<TurnScript, number>();
  readonly served: ServedTurn[] = [];
  private seq = 0;

  load(scripts: TurnScript[]): void {
    for (const script of scripts) {
      if (!script.agent || !script.match || !Array.isArray(script.turns) || script.turns.length === 0) {
        throw new Error("a script needs agent, match and at least one turn");
      }
      if (script.protocol !== "openai-responses" && script.protocol !== "anthropic-messages") {
        throw new Error(`unknown protocol ${String(script.protocol)}`);
      }
    }
    this.scripts.push(...scripts);
  }

  reset(): void {
    this.scripts = [];
    this.cursors.clear();
    this.served.length = 0;
    this.seq = 0;
  }

  /** The SSE body answering `body`, or null when no script of `protocol` matches it. */
  answer(protocol: ScriptProtocol, body: string): string | null {
    const script = this.scripts.find((s) => s.protocol === protocol && body.includes(s.match));
    if (!script) return null;
    const index = Math.min(this.cursors.get(script) ?? 0, script.turns.length - 1);
    this.cursors.set(script, index + 1);
    this.served.push({ agent: script.agent, protocol, turn: index });
    const model = /"model"\s*:\s*"([^"]+)"/.exec(body)?.[1] ?? "scripted";
    const turn = fillTemplates(script.turns[index], body);
    this.seq += 1;
    return protocol === "openai-responses"
      ? renderResponses(turn as ResponsesTurn, `resp_sim_${this.seq}`, model)
      : renderMessages(turn as MessagesTurn, `msg_sim_${this.seq}`, model);
  }
}
