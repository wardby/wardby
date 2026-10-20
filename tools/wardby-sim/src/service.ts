// TEST ONLY (wardby-sim). The contract every simulated service implements.
import type { SimRequest, SimResponse } from "./http.js";
import type { RouteDef } from "./router.js";
import type { SimState } from "./state.js";

export interface RouteContext {
  state: SimState;
  /** Records who the caller authenticated as on this call's log entry (never a credential). */
  principal(name: string): void;
}

/** A scripted step, run by `/__sim/script`. Returns a JSON-able result. */
export type ScriptAction = (args: Record<string, unknown>, ctx: { state: SimState }) => Promise<unknown>;

export interface SimService {
  /** The name calls and faults are keyed by ("github", "slack", ...). */
  name: string;
  /** The URL path prefix the service is mounted at ("/github/api"); no trailing slash. */
  prefix: string;
  /** Answers a call, or `undefined` for a route the service does not have (404). */
  handle(req: SimRequest, ctx: RouteContext): Promise<SimResponse | undefined>;
  /** Every route the service answers (listed in routes.ts with its verified status). */
  routes(): RouteDef[];
  /** Scripted steps this service offers, by action name ("github.webhook"). */
  actions?: Record<string, ScriptAction>;
  /** Called once when the server starts and after every reset. */
  init?(state: SimState): void;
}
