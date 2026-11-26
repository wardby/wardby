// TEST ONLY (wardby-sim). The scripted model endpoints, mounted at /model:
//   POST /model/openai/v1/responses       (OpenAI Responses, streamed)
//   POST /model/anthropic/v1/messages     (Anthropic Messages, streamed; ?beta=true accepted)
//   POST /model/gemini/v1beta/models/<model>:streamGenerateContent     (Gemini AI Studio, SSE)
//   POST /model/vertex/v1/projects/<p>/locations/<l>/publishers/google/models/<model>:streamGenerateContent
//   (Gemini, signed function calls: an unsigned replay answers 400 INVALID_ARGUMENT as the real API does)
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
  const answerGemini = (req: SimRequest): SimResponse => {
    const result = model.answerGemini(req.rawBody.toString("utf8"));
    if (result === null) {
      return json(
        {
          error: {
            code: 501,
            status: "UNIMPLEMENTED",
            message: "sim_no_script: no scripted turn matches this request",
          },
        },
        501,
      );
    }
    if (typeof result === "object") {
      return json(
        {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: "Function call is missing a thought_signature in functionCall parts.",
          },
        },
        400,
      );
    }
    return { status: 200, headers: { "content-type": "text/event-stream" }, body: result };
  };
  // `{model}` captures the whole segment, ":streamGenerateContent" included (the query is not in the path).
  const router = new Router()
    .on("POST", "/openai/v1/responses", answer("openai-responses"))
    .on("POST", "/anthropic/v1/messages", answer("anthropic-messages"))
    .on("POST", "/gemini/v1beta/models/{model}", answerGemini)
    .on("POST", "/vertex/v1/projects/{project}/locations/{location}/publishers/google/models/{model}", answerGemini);

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
