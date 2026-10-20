// TEST ONLY (wardby-sim). Injected faults, keyed by service + method + path pattern.
import { matchPath, type SimResponse } from "./http.js";

export interface FaultSpec {
  /** The service prefix the fault applies to ("github", "slack", ...). */
  service: string;
  /** HTTP method, or "*" for any. */
  method: string;
  /** A path pattern in matchPath's syntax, matched against the path after the service prefix. */
  path: string;
  /** "once" fires on the next matching call only; "sticky" on every one until cleared. */
  mode: "once" | "sticky";
  /** How many matching calls to let through before the fault fires (default 0). */
  after?: number;
  response: SimResponse;
}

export interface Fault extends FaultSpec {
  id: string;
  /** Matching calls seen so far (including those let through by `after`). */
  seen: number;
  fired: number;
}

export class FaultStore {
  private faults: Fault[] = [];
  private next = 1;

  add(spec: FaultSpec): Fault {
    const fault: Fault = { ...spec, id: `fault-${this.next++}`, seen: 0, fired: 0 };
    this.faults.push(fault);
    return fault;
  }

  list(): readonly Fault[] {
    return this.faults;
  }

  remove(id: string): boolean {
    const before = this.faults.length;
    this.faults = this.faults.filter((fault) => fault.id !== id);
    return this.faults.length !== before;
  }

  reset(): void {
    this.faults = [];
    this.next = 1;
  }

  /**
   * The fault that answers this call, if any. A one-shot fault is removed when it fires;
   * the first matching fault (in insertion order) wins.
   */
  take(service: string, method: string, path: string): Fault | undefined {
    for (const fault of this.faults) {
      if (fault.service !== service) continue;
      if (fault.method !== "*" && fault.method.toUpperCase() !== method.toUpperCase()) continue;
      if (!matchPath(fault.path, path)) continue;
      fault.seen += 1;
      if (fault.seen <= (fault.after ?? 0)) continue;
      fault.fired += 1;
      if (fault.mode === "once") this.remove(fault.id);
      return fault;
    }
    return undefined;
  }
}

export function parseFaultSpec(value: unknown): FaultSpec | null {
  if (value === null || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const response = v.response as Record<string, unknown> | undefined;
  if (
    typeof v.service !== "string" ||
    typeof v.method !== "string" ||
    typeof v.path !== "string" ||
    (v.mode !== "once" && v.mode !== "sticky") ||
    !response ||
    typeof response.status !== "number" ||
    (v.after !== undefined && (typeof v.after !== "number" || !Number.isInteger(v.after) || v.after < 0))
  ) {
    return null;
  }
  const headers =
    response.headers && typeof response.headers === "object"
      ? Object.fromEntries(Object.entries(response.headers as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
      : undefined;
  const body =
    typeof response.body === "string"
      ? response.body
      : response.body === undefined
        ? undefined
        : JSON.stringify(response.body);
  return {
    service: v.service,
    method: v.method,
    path: v.path,
    mode: v.mode,
    ...(typeof v.after === "number" ? { after: v.after } : {}),
    response: {
      status: response.status,
      ...(headers
        ? { headers }
        : typeof response.body === "object"
          ? { headers: { "content-type": "application/json" } }
          : {}),
      ...(body !== undefined ? { body } : {}),
    },
  };
}
