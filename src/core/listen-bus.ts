/**
 * A Postgres LISTEN bus: one raw connection per server replica that LISTENs on
 * one channel (fed by NOTIFY, from triggers or pg_notify) and fans validated
 * payloads out to in-process subscribers (an SSE layer). The Viewer bus
 * (src/viewer/event-bus.ts) and the documents bus
 * (src/core/documents/events.ts) are both built on it.
 *
 * - Lazy: no connection until the first subscriber; closed when the last leaves.
 * - Resilient: Cloud SQL maintenance and proxy restarts drop idle connections,
 *   so the client uses TCP keepAlive (probing after 30 s idle) and a periodic
 *   `SELECT 1` health check that catches a half-open socket; on error, end or a
 *   failed check while anyone is subscribed, it reconnects on a backoff
 *   schedule and re-LISTENs.
 * - Subscribers are not told about gaps directly; `onState` reports every
 *   transition to live (including the first LISTEN) and to down, so the SSE
 *   layer can tell its clients to refetch whatever they may have missed.
 */
import pg from "pg";
import type { z } from "zod";
import { poolSettings } from "./db.js";
import { logger } from "./logger.js";
import { type DatabaseAuth, type PgAuthOptions, databaseAuthFromEnv, pgConnectionConfig } from "./pg-auth.js";

const DEFAULT_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 5000, 10_000];
const WARN_INTERVAL_MS = 60_000;
const KEEPALIVE_INITIAL_DELAY_MS = 30_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 10_000;
/** Upper bound on waiting for a graceful disconnect (a half-open socket never answers). */
const END_TIMEOUT_MS = 2_000;
const CHANNEL_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** Channel names are fixed identifiers; anything else is refused rather than quoted. */
function checkChannel(channel: string): string {
  if (!CHANNEL_NAME.test(channel)) throw new Error("invalid LISTEN channel name");
  return channel;
}

/** The LISTEN client's config: auth (pg-auth.ts) plus keepAlive and the pool's connect timeout. */
export function listenClientConfig(
  connectionString: string,
  auth: DatabaseAuth,
  pgAuth?: PgAuthOptions,
): pg.ClientConfig {
  return {
    ...pgConnectionConfig(connectionString, auth, pgAuth),
    keepAlive: true,
    keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
    connectionTimeoutMillis: poolSettings(connectionString).connectionTimeoutMillis,
  };
}

export interface ListenBus<T> {
  subscribe(listener: (event: T) => void): () => void;
  /** True while the LISTEN connection is up (for the SSE "live" indicator). */
  connected(): boolean;
  /**
   * Fires on every transition of the LISTEN connection: `true` once it is up
   * and listening (the first connect and every reconnect), `false` when it is
   * lost. Events between the last `false` (or subscribing) and `true` may
   * have been missed.
   */
  onState(listener: (live: boolean) => void): () => void;
  close(): Promise<void>;
}

export interface ListenBusOptions {
  connectionString: string;
  /** Defaults to DATABASE_AUTH. */
  auth?: DatabaseAuth;
  pgAuth?: PgAuthOptions; // tests
  connect?: (connectionString: string) => pg.Client;
  reconnectDelaysMs?: readonly number[];
  healthCheckIntervalMs?: number; // tests
  healthCheckTimeoutMs?: number; // tests
}

/**
 * A bus on one channel. `name` prefixes every log line ("viewer event bus");
 * `schema` validates each payload, and an invalid one is dropped with a
 * throttled warning (its text is never logged).
 */
export function createListenBus<T>(
  spec: { channel: string; name: string; schema: z.ZodType<T> },
  options: ListenBusOptions,
): ListenBus<T> {
  const { name, schema } = spec;
  const channel = checkChannel(spec.channel);
  const healthIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
  const healthTimeoutMs = options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
  const delays = options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS;
  // Built once, up front: a misconfigured DATABASE_AUTH fails here rather than on every reconnect,
  // and under rds-iam every reconnect shares one token cache.
  const clientConfig = options.connect
    ? undefined
    : listenClientConfig(options.connectionString, options.auth ?? databaseAuthFromEnv(), options.pgAuth);
  const makeClient = options.connect ?? (() => new pg.Client({ ...clientConfig }));

  const listeners = new Set<(event: T) => void>();
  const stateListeners = new Set<(live: boolean) => void>();
  let client: pg.Client | null = null; // the current attempt/connection
  let isUp = false;
  let closed = false;
  let dropped = false; // a connection was lost (or failed) in this session
  let attempt = 0;
  let timer: NodeJS.Timeout | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  const lastWarn = new Map<string, number>();

  function warnThrottled(key: string, message: string, extra: Record<string, unknown> = {}): void {
    const now = Date.now();
    if (now - (lastWarn.get(key) ?? -Infinity) < WARN_INTERVAL_MS) return;
    lastWarn.set(key, now);
    logger.warn(extra, message);
  }

  function dispatch(payload: string | undefined): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload ?? "");
    } catch {
      warnThrottled("invalid", `${name} dropped a non-JSON notification`);
      return;
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      warnThrottled("invalid", `${name} dropped an invalid notification`);
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(result.data);
      } catch (err) {
        warnThrottled("listener", `${name} listener threw`, { err });
      }
    }
  }

  function setLive(live: boolean): void {
    if (isUp === live) return;
    isUp = live;
    for (const l of [...stateListeners]) {
      try {
        l(live);
      } catch (err) {
        warnThrottled("listener", `${name} state listener threw`, { err });
      }
    }
  }

  /** Disconnect, bounded: `end()` waits for the server, which a half-open socket never answers. */
  function endClient(c: pg.Client): Promise<void> {
    // Never leave a client without an error handler: late errors must not crash.
    c.on("error", () => {});
    let bound: NodeJS.Timeout | undefined;
    return Promise.race([
      c.end().catch(() => {}),
      new Promise<void>((resolve) => {
        bound = setTimeout(resolve, END_TIMEOUT_MS);
        bound.unref();
      }),
    ]).finally(() => clearTimeout(bound));
  }

  function discard(c: pg.Client): void {
    void endClient(c);
  }

  function stopHealthCheck(): void {
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
  }

  /** Periodically prove the LISTEN connection still reaches the server. */
  function startHealthCheck(c: pg.Client): void {
    stopHealthCheck();
    let inFlight = false;
    healthTimer = setInterval(() => {
      if (inFlight || c !== client) return;
      inFlight = true;
      let deadline: NodeJS.Timeout | undefined;
      Promise.race([
        c.query("SELECT 1"),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`${name} health check timed out`)), healthTimeoutMs);
          deadline.unref();
        }),
      ])
        .then(
          () => {},
          (err: unknown) => drop(c, err),
        )
        .finally(() => {
          clearTimeout(deadline);
          inFlight = false;
        });
    }, healthIntervalMs);
    healthTimer.unref();
  }

  function scheduleReconnect(): void {
    if (closed || listeners.size === 0 || timer || client) return;
    const delay = delays[Math.min(attempt, delays.length - 1)];
    attempt++;
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
    timer.unref();
  }

  function drop(c: pg.Client, err?: unknown): void {
    if (c !== client) return; // stale: already replaced or stopped
    client = null;
    stopHealthCheck();
    dropped = true;
    warnThrottled("connection", `${name} connection lost`, err ? { err } : {});
    setLive(false);
    discard(c);
    scheduleReconnect();
  }

  function open(): void {
    if (closed || client || timer || listeners.size === 0) return;
    const c = makeClient(options.connectionString);
    client = c;
    c.on("notification", (msg) => {
      if (c === client && msg.channel === channel) dispatch(msg.payload);
    });
    c.on("error", (err) => drop(c, err));
    c.on("end", () => drop(c));
    void (async () => {
      try {
        await c.connect();
        if (c !== client) return discard(c); // stopped while connecting
        await c.query(`LISTEN ${channel}`);
        if (c !== client) return discard(c);
      } catch (err) {
        return drop(c, err);
      }
      attempt = 0;
      if (dropped) {
        dropped = false;
        logger.info({ channel }, `${name} reconnected`);
      }
      startHealthCheck(c);
      setLive(true);
    })();
  }

  /** Tear down the connection and any pending reconnect. */
  async function stop(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    stopHealthCheck();
    const c = client;
    client = null;
    dropped = false;
    attempt = 0;
    setLive(false);
    if (c) await endClient(c);
  }

  return {
    subscribe(listener) {
      if (closed) return () => {};
      listeners.add(listener);
      open();
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) void stop();
      };
    },
    connected: () => isUp,
    onState(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    async close() {
      closed = true;
      listeners.clear();
      stateListeners.clear();
      await stop();
    },
  };
}
