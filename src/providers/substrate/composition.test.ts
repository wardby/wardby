import { describe, expect, it } from "vitest";
import { buildSharedSubstrateApi } from "./composition.js";

const SUBSTRATE = {
  NATIVE_SANDBOX_LAUNCHER: "substrate",
  SUBSTRATE_API_URL: "https://api.ate-system.svc.cluster.local:443",
  SUBSTRATE_TOKEN_FILE: "/var/run/secrets/substrate/token",
  SUBSTRATE_ATESPACE: "wardby-runs",
};

describe("buildSharedSubstrateApi", () => {
  it("builds nothing unless a launcher is substrate", () => {
    expect(buildSharedSubstrateApi({})).toBeUndefined();
    expect(buildSharedSubstrateApi({ JOB_LAUNCHER: "kubernetes" })).toBeUndefined();
  });

  it("builds one client for the native sandbox (no network call: the client is lazy)", () => {
    expect(buildSharedSubstrateApi(SUBSTRATE)).toHaveProperty("createActor");
  });

  it("builds one client for the job launcher", () => {
    const { NATIVE_SANDBOX_LAUNCHER: _omit, ...rest } = SUBSTRATE;
    expect(
      buildSharedSubstrateApi({ ...rest, JOB_LAUNCHER: "substrate", SUBSTRATE_PROXY_HOST: "wardby-proxy.wardby.svc" }),
    ).toHaveProperty("createActor");
  });
});
