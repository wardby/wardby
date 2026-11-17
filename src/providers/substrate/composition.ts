import {
  loadProviderConfig,
  loadSubstrateConnectionConfig,
  loadSubstrateJobConfig,
  type SubstrateConnectionConfig,
} from "../../config/providers.js";
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

/** One SubstrateApi for the process when JOB_LAUNCHER or NATIVE_SANDBOX_LAUNCHER is substrate; undefined otherwise. */
export function buildSharedSubstrateApi(env: NodeJS.ProcessEnv): SubstrateApi | undefined {
  if (loadProviderConfig(env).jobs === "substrate") return createSubstrateApiFor(loadSubstrateJobConfig(env));
  if (env.NATIVE_SANDBOX_LAUNCHER?.trim() === "substrate") {
    return createSubstrateApiFor(loadSubstrateConnectionConfig(env, "NATIVE_SANDBOX_LAUNCHER=substrate"));
  }
  return undefined;
}
