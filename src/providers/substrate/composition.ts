import type { SubstrateConnectionConfig } from "../../config/providers.js";
import type { SubstrateApi } from "./api.js";
import { createSubstrateApi, type SubstrateClientConfig } from "./client.js";

/** The client settings of a connection config; optional ones only when set. */
export function connectionOf(config: SubstrateConnectionConfig): SubstrateClientConfig {
  return {
    baseUrl: config.apiUrl,
    tokenFile: config.tokenFile,
    ...(config.caFile ? { caFile: config.caFile } : {}),
    ...(config.serverName ? { serverName: config.serverName } : {}),
  };
}

export function createSubstrateApiFor(config: SubstrateConnectionConfig): SubstrateApi {
  return createSubstrateApi(connectionOf(config));
}
