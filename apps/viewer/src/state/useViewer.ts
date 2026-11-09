// Stream-first data flow: subscribe to frames and open the event stream BEFORE the
// first graph fetch, so nothing that happens between the two is lost; refetch the
// graph on every `resync` and (debounced) when an event references an unknown run
// or reports a run finishing (today's spend is only in the graph).
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { connect, disconnect, fetchGraph, isAppError, onFrame, type AppError, type FramePayload } from "../api/client";
import { initialModel, isViewerEvent, reduce, type ViewerModel } from "./reducer";

export const REFETCH_DEBOUNCE_MS = 750;
/** Delays before automatic retries of a failed load; after these, the user retries. */
export const RETRY_BACKOFF_MS = [1000, 2000, 5000];

export interface ViewerOptions {
  since: string;
  limit: number;
}

export interface UseViewer {
  model: ViewerModel;
  /** Latest surfaced error (stream ended, connect or fetch failed). */
  error: AppError | null;
  /** The server needs (re)authentication. */
  needsSignIn: boolean;
  /** The account lacks the admin:view role. */
  forbidden: boolean;
  /** The stream dropped and is retrying. */
  reconnecting: boolean;
  /** A graph snapshot has been loaded for the current server. */
  loaded: boolean;
  /** The window (`since`) the latest applied snapshot was fetched for. */
  loadedSince: string | null;
  /** Refetch the graph now (after a failed load). */
  retry: () => void;
}

interface Meta {
  url: string | null;
  error: AppError | null;
  reconnecting: boolean;
  loaded: boolean;
  loadedSince: string | null;
}

const blank = (url: string | null): Meta => ({
  url,
  error: null,
  reconnecting: false,
  loaded: false,
  loadedSince: null,
});

function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  return { kind: "network", message: e instanceof Error ? e.message : String(e) };
}

export function useViewer(serverUrl: string | null, { since, limit }: ViewerOptions): UseViewer {
  const [model, dispatch] = useReducer(reduce, initialModel);
  // Keyed by server so a server switch starts fresh without resetting state in an effect.
  const [meta, setMeta] = useState<Meta>(blank(null));
  const { error, reconnecting, loaded, loadedSince } = meta.url === serverUrl ? meta : blank(serverUrl);

  const sinceRef = useRef(since);
  const limitRef = useRef(limit);
  const agentNames = useRef(new Map<string, string>());
  const knownRuns = useRef<ReadonlySet<string>>(new Set());
  const loadRef = useRef<(() => void) | null>(null);
  /** Retry for the current server: reconnects first when connect itself failed. */
  const retryRef = useRef<(() => void) | null>(null);
  /** A load has been requested for the current server (so a window change must refetch). */
  const requestedRef = useRef(false);

  useEffect(() => {
    sinceRef.current = since;
    limitRef.current = limit;
    if (requestedRef.current) loadRef.current?.();
  }, [since, limit]);

  useEffect(() => {
    const names = new Map<string, string>();
    for (const run of model.runs.values()) names.set(run.agentId, run.agentName);
    agentNames.current = names;
    knownRuns.current = new Set(model.runs.keys());
  }, [model.runs]);

  useEffect(() => {
    if (!serverUrl) return;
    let active = true;
    let seq = 0;
    let unlisten: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastFetchAt = 0;
    let failed = false;
    let connectFailed = false;
    let failures = 0;
    // Events that needed a refetch vs. how many the last fetch started after.
    let needSeq = 0;
    let fetchedNeedSeq = 0;

    dispatch({ type: "reset" });
    requestedRef.current = false;

    const patch = (p: Partial<Omit<Meta, "url">>) =>
      setMeta((m) => ({ ...(m.url === serverUrl ? m : blank(serverUrl)), ...p }));

    const schedule = (delay: number, force: boolean) => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        if (force || needSeq > fetchedNeedSeq) void load();
      }, delay);
    };

    const load = async () => {
      requestedRef.current = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      const mine = ++seq;
      lastFetchAt = Date.now();
      fetchedNeedSeq = needSeq;
      failed = false;
      try {
        const since = sinceRef.current;
        const snapshot = await fetchGraph(serverUrl, since, limitRef.current);
        // A newer load (window change, resync) supersedes this response.
        if (!active || mine !== seq) return;
        failures = 0;
        patch({ loaded: true, loadedSince: since, error: null });
        dispatch({ type: "snapshot", snapshot });
        // An unknown-run event arrived after this fetch started: it is not in the snapshot.
        if (needSeq > fetchedNeedSeq) schedule(REFETCH_DEBOUNCE_MS, false);
      } catch (e) {
        if (!active || mine !== seq) return;
        failed = true;
        const err = toAppError(e);
        patch({ error: err });
        if (err.kind !== "not_signed_in" && err.kind !== "forbidden" && failures < RETRY_BACKOFF_MS.length) {
          schedule(RETRY_BACKOFF_MS[failures], true);
          failures += 1;
        }
      }
    };
    loadRef.current = () => void load();

    // Connect failures that need no sign-in (the Keychain, a broken config) do not heal
    // by themselves, so Retry runs connect again before loading.
    const open = async () => {
      try {
        await connect(serverUrl);
        connectFailed = false;
        if (active && !requestedRef.current) void load();
      } catch (e) {
        if (!active) return;
        const err = toAppError(e);
        connectFailed = err.kind !== "not_signed_in" && err.kind !== "forbidden";
        patch({ error: err });
      }
    };
    retryRef.current = () => {
      if (!connectFailed) return void load();
      patch({ error: null });
      void open();
    };

    const handle = ({ server, frame }: FramePayload) => {
      if (!active || server !== serverUrl) return;
      switch (frame.type) {
        case "hello":
        case "status":
          dispatch({ type: "status", connected: frame.connected });
          if (frame.connected) {
            patch({ reconnecting: false });
            // The stream is back: retry a load that failed, or start the first one.
            if (failed || (frame.type === "hello" && !requestedRef.current)) void load();
          }
          break;
        case "resync":
          void load();
          break;
        case "event": {
          // Dropped, not thrown on: a newer server may send shapes this build predates.
          if (!isViewerEvent(frame.data)) break;
          // A step only marks a run's detail stale: it never needs the graph, even for a run not shown.
          if (frame.data.kind !== "step") {
            const unknown = frame.data.kind === "outcome" || !knownRuns.current.has(frame.data.runId);
            // Today's spend comes only from the graph, so a finished run's final cost needs a refetch.
            const finished = frame.data.kind === "run" && frame.data.finishedAt !== null;
            if (unknown || finished) {
              needSeq += 1;
              schedule(Math.max(0, REFETCH_DEBOUNCE_MS - (Date.now() - lastFetchAt)), false);
            }
          }
          dispatch({
            type: "event",
            event: frame.data,
            at: Date.now(),
            agentName: (id) => agentNames.current.get(id),
          });
          break;
        }
        case "reconnecting":
          dispatch({ type: "status", connected: false });
          patch({ reconnecting: true });
          break;
        case "ended":
          dispatch({ type: "status", connected: false });
          patch({ reconnecting: false, error: frame.error });
          break;
      }
    };

    void (async () => {
      try {
        const off = await onFrame(handle);
        if (!active) {
          off();
          return;
        }
        unlisten = off;
        await open();
      } catch (e) {
        if (active) patch({ error: toAppError(e) });
      }
    })();

    return () => {
      active = false;
      loadRef.current = null;
      retryRef.current = null;
      // The stream is stopped below, so nothing may go on claiming it is live
      // (also covers a view that is torn down without a new server to reset for).
      dispatch({ type: "status", connected: false });
      clearTimeout(timer);
      unlisten?.();
      void disconnect(serverUrl).catch(() => undefined);
    };
  }, [serverUrl]);

  const retry = useCallback(() => retryRef.current?.(), []);

  return {
    model,
    error,
    needsSignIn: error?.kind === "not_signed_in",
    forbidden: error?.kind === "forbidden",
    reconnecting,
    loaded,
    loadedSince,
    retry,
  };
}
