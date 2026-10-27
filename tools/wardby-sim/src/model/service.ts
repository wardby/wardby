// TEST ONLY (wardby-sim). The scripted model endpoints, mounted at /model:
//   POST /model/openai/v1/responses       (OpenAI Responses, streamed)
//   POST /model/anthropic/v1/messages     (Anthropic Messages, streamed; ?beta=true accepted)
// Any credential is accepted and never recorded (the call log keeps its scheme only). A request
// no loaded script matches answers 501 sim_no_script, so a run never silently gets a reply it
// was not scripted for.
import { json, record, type SimRequest, type SimResponse } from "../http.js";
import { Router } from "../router.js";
import type { ScriptAction, SimService } from "../service.js";
import type { SimState } from "../state.js";
import { ScriptedModel, type ScriptProtocol, type TurnScript } from "./script.js";

export const MODEL_PREFIX = "/model";

export function createModelService(): SimService {
  const model = new ScriptedModel();
  const answer =
    (protocol: ScriptProtocol) =>
    (req: SimRequest): SimResponse => {
      const body = req.rawBody.toString("utf8");
      const stream = model.answer(protocol, body);
      if (stream === null) {
        return json(
          protocol === "openai-responses"
            ? { error: { code: "sim_no_script", message: "no scripted turn matches this request" } }
            : { type: "error", error: { type: "sim_no_script", message: "no scripted turn matches this request" } },
          501,
        );
      }
      return { status: 200, headers: { "content-type": "text/event-stream" }, body: stream };
    };
  const router = new Router()
    .on("POST", "/openai/v1/responses", answer("openai-responses"))
    .on("POST", "/anthropic/v1/messages", answer("anthropic-messages"));

  const actions: Record<string, ScriptAction> = {
    "model.load": async (args) => {
      const scripts = Array.isArray(args.scripts) ? (args.scripts.map(record) as unknown as TurnScript[]) : [];
      model.load(scripts);
      return { loaded: scripts.map((s) => `${s.agent}:${s.protocol}`) };
    },
    "model.served": async () => ({ served: model.served }),
  };

  return {
    name: "model",
    prefix: MODEL_PREFIX,
    handle: (req, ctx) => router.handle(req, ctx),
    routes: () => router.routes(),
    actions,
    init: (state: SimState) => {
      if (!state.part("model")) state.register("model", model);
    },
  };
}
