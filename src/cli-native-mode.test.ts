import { describe, expect, it } from "vitest";
import { parseCliNativeExecutionMode } from "./cli-native-mode.js";

const DOCKER_SANDBOX = {
  NATIVE_SANDBOX_LAUNCHER: "docker",
  NATIVE_SANDBOX_WORKER_IMAGE: "wardby-native-worker:dev",
  NATIVE_GATEWAY_CONTAINER: "wardby-native-gateway",
};

describe("parseCliNativeExecutionMode", () => {
  it("maps control-plane to the stored spelling, sandbox or not", () => {
    expect(parseCliNativeExecutionMode("control-plane", {})).toBe("control_plane");
    expect(parseCliNativeExecutionMode("control-plane", DOCKER_SANDBOX)).toBe("control_plane");
  });

  it("accepts sandbox where this environment configures a native sandbox", () => {
    expect(parseCliNativeExecutionMode("sandbox", DOCKER_SANDBOX)).toBe("sandbox");
  });

  it("refuses sandbox with native_sandbox_unavailable when no sandbox is configured", () => {
    expect(() => parseCliNativeExecutionMode("sandbox", {})).toThrow(/^native_sandbox_unavailable:/);
  });

  it("surfaces a bad sandbox configuration instead of storing the mode", () => {
    expect(() => parseCliNativeExecutionMode("sandbox", { NATIVE_SANDBOX_LAUNCHER: "docker" })).toThrow(
      /NATIVE_SANDBOX_WORKER_IMAGE is required/,
    );
  });

  it("rejects other spellings, including the stored one", () => {
    expect(() => parseCliNativeExecutionMode("control_plane", {})).toThrow(
      /native execution mode must be "control-plane" or "sandbox"/,
    );
    expect(() => parseCliNativeExecutionMode("", {})).toThrow(
      /native execution mode must be "control-plane" or "sandbox"/,
    );
  });
});
