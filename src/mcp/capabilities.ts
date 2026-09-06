/**
 * Tasks extension identity + per-request client-capability inspection.
 * `io.modelcontextprotocol/tasks` capabilities have no settings of their
 * own (an empty object means "supported"), per the extension's own spec.
 */
export const TASKS_EXTENSION_ID = "io.modelcontextprotocol/tasks";

export interface ClientCapabilitiesLike {
  extensions?: Record<string, unknown>;
}

/** Whether a request's declared client capabilities include the Tasks extension. */
export function clientSupportsTasks(clientCapabilities: ClientCapabilitiesLike | undefined): boolean {
  return Boolean(clientCapabilities?.extensions?.[TASKS_EXTENSION_ID]);
}
