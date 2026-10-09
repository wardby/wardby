import type { NativeExecutionMode } from "#prisma";
import { loadNativeSandboxConfig } from "./config/providers.js";

/**
 * `--native-execution-mode` for the CLI: the operator spelling MCP takes
 * (`control-plane` | `sandbox`) mapped to the stored enum. `sandbox` is
 * refused unless this process's environment configures a native sandbox, the
 * same rule `create_agent`/`update_agent` apply, so the CLI never stores a
 * mode whose every run would fail closed. Throws with the message to print.
 */
export function parseCliNativeExecutionMode(value: string, env: NodeJS.ProcessEnv = process.env): NativeExecutionMode {
  if (value === "control-plane") return "control_plane";
  if (value !== "sandbox") {
    throw new Error(`the native execution mode must be "control-plane" or "sandbox" (got "${value}").`);
  }
  if (loadNativeSandboxConfig(env) === undefined) {
    throw new Error(
      "native_sandbox_unavailable: this environment has no native sandbox configured (set NATIVE_SANDBOX_LAUNCHER), " +
        'so an agent cannot use native execution mode "sandbox".',
    );
  }
  return "sandbox";
}
