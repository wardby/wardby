/**
 * Viewer event bus: the shared LISTEN bus (src/core/listen-bus.ts) on
 * `wardby_viewer`, fed by the viewer NOTIFY triggers, with payloads checked
 * against ViewerEventSchema. Connection, reconnect and health-check behaviour
 * live in the shared module.
 */
import type pg from "pg";
import { createListenBus, listenClientConfig, type ListenBus, type ListenBusOptions } from "../core/listen-bus.js";
import type { DatabaseAuth, PgAuthOptions } from "../core/pg-auth.js";
import { ViewerEventSchema, type ViewerEvent } from "./api-schema.js";

export const VIEWER_CHANNEL = "wardby_viewer";

export type ViewerEventBus = ListenBus<ViewerEvent>;

/** The LISTEN client's config: auth (pg-auth.ts) plus keepAlive and the pool's connect timeout. */
export function eventBusClientConfig(
  connectionString: string,
  auth: DatabaseAuth,
  pgAuth?: PgAuthOptions,
): pg.ClientConfig {
  return listenClientConfig(connectionString, auth, pgAuth);
}

export function createViewerEventBus(options: ListenBusOptions): ViewerEventBus {
  return createListenBus({ channel: VIEWER_CHANNEL, name: "viewer event bus", schema: ViewerEventSchema }, options);
}
