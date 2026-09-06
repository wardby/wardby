/**
 * Secret-cipher selector — builds the adapter for the configured
 * SECRET_CIPHER kind. `kms` is reserved (no adapter yet); selecting it
 * fails closed with a clear error, mirroring how the config seam handles
 * other not-yet-built kinds (e.g. bedrock in the LLM router).
 */
import type { ProviderConfig } from "../../config/providers.js";
import { loadSecretConfig } from "../../config/providers.js";
import type { SecretCipher } from "./types.js";
import { AppKeySecretCipher } from "./app-key.js";

export { AppKeySecretCipher } from "./app-key.js";

export function buildSecretCipher(
  config: Pick<ProviderConfig, "secrets">,
  env: NodeJS.ProcessEnv = process.env,
): SecretCipher {
  if (config.secrets === "kms") {
    throw new Error("SECRET_CIPHER=kms not implemented (reserved).");
  }
  const { appKey } = loadSecretConfig(env);
  if (!appKey) {
    throw new Error("SECRET_APP_KEY is not set — required by the app-key SecretCipher adapter.");
  }
  return new AppKeySecretCipher(appKey);
}
