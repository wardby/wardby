// Typed wrappers over the Rust commands. Tokens never reach JavaScript: these
// calls carry server names, URLs, sign-in state and server JSON only.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { ClusterPayload, InfraEvent } from "../infra/types";
import type { DocumentList, GraphSnapshot, InfraInfo, RunDetail, ViewerEvent } from "./types";

export const FRAME_EVENT = "viewer://frame";
export const CLUSTER_EVENT = "viewer://cluster";

/** Mirrors the Rust `AppError` serialization. */
export type AppErrorKind =
  | "network"
  | "http"
  | "protocol"
  | "denied"
  | "timeout"
  | "cancelled"
  | "not_wardby"
  | "needs_client_id"
  | "keychain"
  | "storage"
  | "not_signed_in"
  | "forbidden";

export interface AppError {
  kind: AppErrorKind;
  message: string;
  status?: number;
}

/** True for the `{ kind, message }` shape commands reject with. */
export function isAppError(e: unknown): e is AppError {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as AppError).kind === "string" &&
    typeof (e as AppError).message === "string"
  );
}

export interface ServerSummary {
  name: string;
  url: string;
  signed_in: boolean;
  /** The kubeconfig context the Infrastructure view reads for this server. */
  kube_context: string | null;
}

/** Mirrors the Rust `StreamFrame`, tagged by `type`. */
export type StreamFrame =
  | { type: "hello"; connected: boolean }
  | { type: "status"; connected: boolean }
  | { type: "resync" }
  | { type: "event"; kind: string; data: ViewerEvent }
  | { type: "reconnecting"; attempt: number; delay_ms: number }
  | { type: "ended"; error: AppError };

export interface FramePayload {
  server: string;
  frame: StreamFrame;
}

export const listServers = () => invoke<ServerSummary[]>("list_servers");

export const addServer = (name: string, url: string, clientId?: string) =>
  invoke<void>("add_server", { name, url, clientId: clientId ?? null });

export const removeServer = (url: string) => invoke<void>("remove_server", { url });

/** Opens the system browser and resolves once sign-in completes (up to 5 minutes). */
export const signIn = (url: string) => invoke<void>("sign_in", { url });

/** Aborts a pending sign-in for the server (its `signIn` call rejects with kind "cancelled"). */
export const cancelSignIn = (url: string) => invoke<void>("cancel_sign_in", { url });

export const signOut = (url: string) => invoke<void>("sign_out", { url });

/** Starts the live event stream for a server, replacing any previous one. */
export const connect = (url: string) => invoke<void>("connect", { url });

/** Stops the stream only if it belongs to this server (a late call can't kill another's). */
export const disconnect = (url: string) => invoke<void>("disconnect", { url });

export const fetchGraph = (url: string, since: string, limit: number) =>
  invoke<GraphSnapshot>("fetch_graph", { url, since, limit });

export const fetchRun = (url: string, id: string) => invoke<RunDetail>("fetch_run", { url, id });

export const fetchInfra = (url: string) => invoke<InfraInfo>("fetch_infra", { url });

/** The documents and designs the signed-in admin owns or was granted read access to. */
export const fetchDocuments = (url: string, limit: number) => invoke<DocumentList>("fetch_documents", { url, limit });

/** The contexts in the user's kubeconfig (names only). */
export const kubeContexts = () => invoke<{ current: string | null; contexts: string[] }>("kube_contexts");

/** Saves which kubeconfig context to use for a server; `null` clears it. */
export const setKubeContext = (url: string, context: string | null) =>
  invoke<void>("set_kube_context", { url, context });

/**
 * Starts the live, read-only watch of a namespace, replacing any previous one for the
 * server. Frames arrive on `CLUSTER_EVENT`; rejects with a `ClusterError`.
 */
export const kubeConnect = (url: string, context: string, namespace: string) =>
  invoke<void>("kube_connect", { url, context, namespace });

/** Stops the server's cluster watch. */
export const kubeDisconnect = (url: string) => invoke<void>("kube_disconnect", { url });

/** The newest events for one pod; rejects with a `ClusterError`. */
export const kubePodEvents = (context: string, namespace: string, pod: string) =>
  invoke<InfraEvent[]>("kube_pod_events", { context, namespace, pod });

/** Opens an `https://` link in the system browser; Rust rejects every other scheme. */
export const openUrl = (url: string) => invoke<void>("open_url", { url });

/** Subscribes to stream frames; resolves to the function that unsubscribes. */
export function onFrame(cb: (payload: FramePayload) => void): Promise<UnlistenFn> {
  return listen<FramePayload>(FRAME_EVENT, (e) => cb(e.payload));
}

/** Subscribes to cluster frames; resolves to the function that unsubscribes. */
export function onCluster(cb: (payload: ClusterPayload) => void): Promise<UnlistenFn> {
  return listen<ClusterPayload>(CLUSTER_EVENT, (e) => cb(e.payload));
}
