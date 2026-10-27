// TEST ONLY (wardby-sim). The control API a test drives the simulator with:
//   POST   /__sim/reset              clear every service's state, the call log and faults
//   POST   /__sim/script             { steps: [{ action, ...args }] } run in order
//   GET    /__sim/faults             list faults
//   POST   /__sim/faults             add a fault (FaultSpec)
//   DELETE /__sim/faults[/{id}]      clear all faults, or one
//   GET    /__sim/calls              recorded calls (?service=&since=&method=&path_prefix=)
//   GET    /__sim/routes             the route table, with each route's verified status
//   GET    /__sim/health
import { json, jsonBody, empty, matchPath, record, type SimRequest, type SimResponse } from "./http.js";
import { parseFaultSpec } from "./faults.js";
import type { ScriptAction, SimService } from "./service.js";
import type { SimState } from "./state.js";
import { ROUTES } from "./routes.js";

export const CONTROL_PREFIX = "/__sim";

export function controlActions(services: readonly SimService[]): Map<string, ScriptAction> {
  const actions = new Map<string, ScriptAction>();
  for (const service of services) {
    for (const [name, action] of Object.entries(service.actions ?? {})) {
      if (actions.has(name)) throw new Error(`duplicate script action: ${name}`);
      actions.set(name, action);
    }
  }
  return actions;
}

export async function handleControl(
  req: SimRequest,
  state: SimState,
  actions: ReadonlyMap<string, ScriptAction>,
  reset: () => void,
): Promise<SimResponse> {
  const { method, path } = req;
  if (method === "GET" && path === "/health") return json({ ok: true });
  if (method === "POST" && path === "/reset") {
    reset();
    return empty(204);
  }
  if (method === "GET" && path === "/routes") return json({ routes: ROUTES });
  if (method === "GET" && path === "/calls") {
    const since = req.query.get("since");
    return json({
      calls: state.calls.list({
        ...(req.query.get("service") ? { service: req.query.get("service")! } : {}),
        ...(since !== null && /^\d+$/.test(since) ? { since: Number(since) } : {}),
        ...(req.query.get("method") ? { method: req.query.get("method")! } : {}),
        ...(req.query.get("path_prefix") ? { pathPrefix: req.query.get("path_prefix")! } : {}),
      }),
    });
  }
  if (path === "/faults") {
    if (method === "GET") return json({ faults: state.faults.list() });
    if (method === "POST") {
      const spec = parseFaultSpec(jsonBody(req));
      if (!spec) return json({ error: "invalid_fault" }, 400);
      return json(state.faults.add(spec), 201);
    }
    if (method === "DELETE") {
      state.faults.reset();
      return empty(204);
    }
  }
  const one = matchPath("/faults/{id}", path);
  if (one && method === "DELETE") return state.faults.remove(one.id) ? empty(204) : json({ error: "not_found" }, 404);
  if (method === "POST" && path === "/script") {
    const steps = record(jsonBody(req)).steps;
    if (!Array.isArray(steps)) return json({ error: "invalid_script" }, 400);
    const results: unknown[] = [];
    for (const [index, step] of steps.entries()) {
      const args = record(step);
      const action = typeof args.action === "string" ? actions.get(args.action) : undefined;
      if (!action) return json({ error: "unknown_action", index, results }, 400);
      try {
        results.push(await action(args, { state }));
      } catch (error) {
        return json({ error: "action_failed", index, message: (error as Error).message, results }, 400);
      }
    }
    return json({ results });
  }
  return json({ error: "not_found" }, 404);
}
