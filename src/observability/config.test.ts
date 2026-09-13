import { describe, expect, it } from "vitest";
import { loadMetricsConfig } from "./config.js";

describe("metrics configuration", () => {
  it("keeps the listener disabled by default and permits loopback", () => {
    expect(loadMetricsConfig({})).toEqual({});
    expect(loadMetricsConfig({ METRICS_BIND: "127.0.0.1:9464" })).toEqual({
      bind: { host: "127.0.0.1", port: 9464 },
    });
  });

  it("requires an explicit acknowledgement before binding metrics beyond loopback", () => {
    expect(() => loadMetricsConfig({ METRICS_BIND: "0.0.0.0:9464" })).toThrow("METRICS_ALLOW_NON_LOOPBACK");
    expect(loadMetricsConfig({ METRICS_BIND: "0.0.0.0:9464", METRICS_ALLOW_NON_LOOPBACK: "true" })).toEqual({
      bind: { host: "0.0.0.0", port: 9464 },
    });
  });

  it.each(["localhost:9464", "127.0.0.1:0", "127.0.0.1:70000", "https://127.0.0.1:9464"])(
    "rejects unsafe metrics bind %s",
    (bind) => {
      expect(() => loadMetricsConfig({ METRICS_BIND: bind })).toThrow("METRICS_BIND");
    },
  );
});
