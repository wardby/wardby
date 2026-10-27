/**
 * A deterministic interleaving harness for lifecycle races against the real database. One actor's
 * database is wrapped so every model call it makes (inside `$transaction` too) is a numbered yield
 * point; the competing actor runs, once, right before the actor's k-th call. Sweeping k over every
 * call of an uninterrupted run tries the competitor at every point the actor touches the database.
 *
 * A competitor that blocks on a row lock the actor holds (a transaction the actor has open) cannot
 * finish before the actor goes on; it is given BLOCKED_MS and then left to finish after the actor,
 * which is what the database would do with two processes.
 *
 * Every successful terminal write (a run row made terminal) by either side is recorded as a claim.
 */

const TERMINAL = new Set(["succeeded", "failed", "refused", "lost", "budget_exhausted", "cancelled"]);
const BLOCKED_MS = 1_500;

export interface Claim {
  actor: string;
  op: string;
  status: string;
  /** Yield points the actor had passed when the claim landed. */
  at: number;
}

type Hook = (op: string) => Promise<void>;
type After = (op: string, args: unknown, result: unknown) => void;

function wrap<T extends object>(db: T, before: Hook, after: After): T {
  return new Proxy(db, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (prop === "$transaction" && typeof value === "function") {
        return (arg: unknown, options?: unknown) =>
          typeof arg === "function"
            ? (value as (fn: unknown, o?: unknown) => unknown).call(
                target,
                (tx: object) => (arg as (tx: object) => unknown)(wrap(tx, before, after)),
                options,
              )
            : (value as (a: unknown, o?: unknown) => unknown).call(target, arg, options);
      }
      if (typeof value === "function") return (value as (...a: unknown[]) => unknown).bind(target);
      if (!value || typeof value !== "object" || typeof prop !== "string" || prop.startsWith("$")) return value;
      return new Proxy(value, {
        get(model, key) {
          const method: unknown = Reflect.get(model, key);
          if (typeof method !== "function") return method;
          return async (...args: unknown[]) => {
            const op = `${prop}.${String(key)}`;
            await before(op);
            const result: unknown = await (method as (...a: unknown[]) => unknown).apply(model, args);
            after(op, args[0], result);
            return result;
          };
        },
      });
    },
  });
}

function terminalStatusOf(op: string, args: unknown, result: unknown): string | undefined {
  if (op !== "run.update" && op !== "run.updateMany") return undefined;
  const data = (args as { data?: { status?: unknown } } | undefined)?.data;
  const status = typeof data?.status === "string" ? data.status : undefined;
  if (!status || !TERMINAL.has(status)) return undefined;
  if (op === "run.updateMany" && (result as { count?: number } | undefined)?.count === 0) return undefined;
  return status;
}

export interface Interleaving<T extends object> {
  /** The actor's database: its k-th call first runs the competitor. */
  actorDb: T;
  /** The competitor's database: only observed. */
  competitorDb: T;
  claims: Claim[];
  /** Calls the actor made. */
  calls(): number;
  /** The actor's calls, in order (`model.method`). */
  ops(): readonly string[];
  /** Whether the competitor ran, and whether it finished before the actor went on. */
  competitor(): { ran: boolean; blocked: boolean };
  /** Waits for a competitor left blocked to finish. */
  settled(): Promise<void>;
}

/**
 * `injectAt`: the actor call before which `competitor` runs (Infinity: never; a dry run counts the
 * calls). Calls only count while `counting()` is true, so the competitor's own calls through a
 * shared object are never numbered.
 */
export function interleave<T extends object>(
  db: T,
  injectAt: number,
  competitor: () => Promise<unknown>,
): Interleaving<T> {
  const claims: Claim[] = [];
  const ops: string[] = [];
  let calls = 0;
  let ran = false;
  let blocked = false;
  let running: Promise<unknown> | undefined;
  let inCompetitor = false;
  const observe =
    (actor: string): After =>
    (op, args, result) => {
      const status = terminalStatusOf(op, args, result);
      if (status) claims.push({ actor, op, status, at: calls });
    };
  const before: Hook = async (op) => {
    if (inCompetitor) return;
    const index = calls++;
    ops.push(op);
    if (index !== injectAt || ran) return;
    ran = true;
    inCompetitor = true;
    running = competitor().catch((err: unknown) => err);
    const finished = await Promise.race([
      running.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), BLOCKED_MS)),
    ]);
    blocked = !finished;
    inCompetitor = false;
  };
  return {
    actorDb: wrap(db, before, observe("actor")),
    competitorDb: wrap(db, async () => undefined, observe("competitor")),
    claims,
    calls: () => calls,
    ops: () => ops,
    competitor: () => ({ ran, blocked }),
    settled: async () => {
      await running;
    },
  };
}
