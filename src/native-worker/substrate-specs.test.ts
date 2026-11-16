import { describe, expect, it } from "vitest";
import { actorMetadataMount, actorMetadataVolume, READY_PORT } from "../providers/substrate/templates.js";
import { FAKE_NATIVE_CAP, GATEWAY_URL, NATIVE_CONFIG, NATIVE_IMAGE } from "./substrate-launcher.test-support.js";
import {
  gatewayTarget,
  NATIVE_WORKER_COMMAND,
  nativeEgress,
  nativeRunSecret,
  nativeTemplate,
} from "./substrate-specs.js";

const token = "wr-0123456789abcdef0123";

describe("nativeTemplate", () => {
  it("builds one secret-free template", () => {
    const template = nativeTemplate(NATIVE_CONFIG);
    expect(template.containers).toEqual([
      {
        name: "native",
        image: NATIVE_IMAGE,
        command: [...NATIVE_WORKER_COMMAND],
        env: [
          { name: "WARDBY_NATIVE_SUBSTRATE", value: "1" },
          { name: "NATIVE_GATEWAY_URL", value: GATEWAY_URL },
        ],
        wakeupProbe: { path: "/readyz", port: READY_PORT },
        volumeMounts: [{ name: "tmp", mountPath: "/tmp" }, actorMetadataMount],
      },
    ]);
    expect(template.volumes).toEqual([{ name: "tmp", durableDir: true }, actorMetadataVolume]);
    expect(template.cpuMillicores).toBe(1000);
    expect(template.memoryBytes).toBe(536_870_912);
    expect(template.snapshotFidelity).toBe("MEMORY");
    expect(template.atespace).toBe("wardby-runs");
    expect(template.workerSelector).toBeUndefined();
    expect(template.name).toMatch(/^wardby-native-[0-9a-f]{16}$/);
  });

  it("names a new template for any change of image, size, gateway or selector, and the same one otherwise", () => {
    const variants = [
      NATIVE_CONFIG,
      { ...NATIVE_CONFIG, image: "registry.example/wardby-native-worker@sha256:" + "b".repeat(64) },
      { ...NATIVE_CONFIG, cpus: 2 },
      { ...NATIVE_CONFIG, memoryMb: 1024 },
      { ...NATIVE_CONFIG, gatewayUrl: "http://other-gateway.wardby.svc.cluster.local:8790/native-gateway/v1/call" },
      { ...NATIVE_CONFIG, workerSelector: { pool: "native" } },
    ].map((config) => nativeTemplate(config).name);
    expect(new Set(variants).size).toBe(variants.length);
    expect(nativeTemplate({ ...NATIVE_CONFIG })).toEqual(nativeTemplate({ ...NATIVE_CONFIG }));
    expect(nativeTemplate({ ...NATIVE_CONFIG, workerSelector: { a: "1", b: "2" } }).name).toBe(
      nativeTemplate({ ...NATIVE_CONFIG, workerSelector: { b: "2", a: "1" } }).name,
    );
    expect(nativeTemplate({ ...NATIVE_CONFIG, workerSelector: { pool: "native" } }).workerSelector).toEqual({
      pool: "native",
    });
  });

  it("refuses a size that rounds to nothing", () => {
    expect(() => nativeTemplate({ ...NATIVE_CONFIG, cpus: 0.0001 })).toThrow("substrate_limits_too_small");
  });
});

describe("nativeEgress", () => {
  it("routes the run actor's egress to the gateway only, with the capability injected", () => {
    expect(nativeEgress("wr-0123456789abcdef0123", NATIVE_CONFIG)).toEqual([
      {
        kind: "http",
        hostnames: ["wardby-native-gateway.wardby.svc.cluster.local"],
        ports: [8790],
        replaceHeaders: [
          {
            header: "Authorization",
            prefix: "Bearer ",
            credentialUri: "ate-secret://k8s.io/default/wardby-run-credentials/wr-0123456789abcdef0123/capability",
          },
        ],
      },
    ]);
    expect(gatewayTarget("http://gw.example/native-gateway/v1/call")).toEqual({ host: "gw.example", port: 80 });
    expect(gatewayTarget("https://gw.example/native-gateway/v1/call")).toEqual({ host: "gw.example", port: 443 });
  });
});

describe("never a secret or a run value in what Substrate logs", () => {
  it("never puts a secret or a run value in the template or the policy", () => {
    const text = JSON.stringify([nativeTemplate(NATIVE_CONFIG), nativeEgress(token, NATIVE_CONFIG)]);
    expect(text).not.toContain(FAKE_NATIVE_CAP);
    expect(text).not.toContain("run-1");
    expect(JSON.stringify(nativeTemplate(NATIVE_CONFIG))).not.toContain(token);
  });

  it("keeps the capability in the Secret only", () => {
    const secret = nativeRunSecret(token, FAKE_NATIVE_CAP, NATIVE_CONFIG);
    expect(secret.metadata).toEqual({
      name: token,
      namespace: "wardby-run-credentials",
      labels: { "wardby.dev/substrate-native-run": token },
    });
    expect(secret.stringData).toEqual({ capability: FAKE_NATIVE_CAP });
  });
});
