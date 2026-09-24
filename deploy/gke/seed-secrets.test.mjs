import { describe, expect, it } from "vitest";
import { SECRETS, decideSeed, generateHexKey, seed } from "./seed-secrets.mjs";

const entry = (id) => SECRETS.find((s) => s.id === id);
const never = () => {
  throw new Error("generate must not be called");
};

describe("decideSeed", () => {
  it("keeps a secret that already has a version", () => {
    expect(decideSeed(entry("openai-api-key"), { hasVersion: true, cluster: "c", env: "e", generate: never })).toEqual({
      action: "keep",
    });
  });

  it("prefers the live cluster value over .env.local", () => {
    expect(decideSeed(entry("secret-app-key"), { hasVersion: false, cluster: "c", env: "e", generate: never })).toEqual(
      {
        action: "add",
        from: "cluster",
        value: "c",
      },
    );
  });

  it("falls back to .env.local when the cluster has no value", () => {
    expect(decideSeed(entry("github-app-id"), { hasVersion: false, env: "e", generate: never })).toEqual({
      action: "add",
      from: ".env.local",
      value: "e",
    });
  });

  it("generates only the two auth keys", () => {
    for (const id of ["auth-signing-key", "auth-credential-hash-key"]) {
      expect(decideSeed(entry(id), { hasVersion: false, generate: () => "g" })).toEqual({
        action: "add",
        from: "generated",
        value: "g",
      });
    }
  });

  it("refuses to invent any other secret", () => {
    const decision = decideSeed(entry("github-app-private-key"), { hasVersion: false, generate: never });
    expect(decision.action).toBe("error");
    expect(decision.message).toContain("GITHUB_APP_PRIVATE_KEY");
  });

  it("adds database-url from Terraform only when it differs from the latest version", () => {
    const db = entry("database-url");
    expect(decideSeed(db, { hasVersion: true, latest: "u", terraform: "u", generate: never })).toEqual({
      action: "keep",
    });
    expect(decideSeed(db, { hasVersion: true, latest: "old", terraform: "u", generate: never })).toEqual({
      action: "add",
      from: "terraform",
      value: "u",
    });
    expect(decideSeed(db, { hasVersion: false, terraform: "u", generate: never })).toEqual({
      action: "add",
      from: "terraform",
      value: "u",
    });
    expect(decideSeed(db, { hasVersion: false, terraform: "", generate: never }).action).toBe("error");
  });
});

describe("generateHexKey", () => {
  it("returns 32 random bytes as 64 lowercase hex characters", () => {
    const a = generateHexKey();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(generateHexKey()).not.toBe(a);
  });
});

// A fake exec that answers the exact commands seed() issues and records them.
function fakeExec({ versions = {}, cluster, terraform = "postgresql://db" }) {
  const calls = [];
  const exec = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, input: options.input });
    if (cmd === "terraform") return { code: 0, stdout: terraform, stderr: "" };
    if (cmd === "kubectl") {
      if (!cluster) return { code: 1, stdout: "", stderr: 'Error from server (NotFound): secrets "x" not found' };
      const data = Object.fromEntries(Object.entries(cluster).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    }
    const name = args[args.indexOf("versions") + 2] ?? args[args.indexOf("--secret") + 1];
    if (args.includes("list")) return { code: 0, stdout: versions[name] ? "1\n" : "", stderr: "" };
    if (args.includes("access"))
      return { code: 0, stdout: versions[args[args.indexOf("--secret") + 1]] ?? "", stderr: "" };
    if (args.includes("add")) return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  };
  return { exec, calls };
}

const base = { project: "p", prefix: "wardby", context: "ctx", namespace: "wardby-coding", tfDir: "deploy/gke" };
const fullEnv = {
  OPENAI_API_KEY: "sk-openai-secret",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  SECRET_APP_KEY: "a".repeat(64),
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
};

describe("seed", () => {
  it("writes nothing when any secret has no source", async () => {
    const { exec, calls } = fakeExec({});
    const env = { ...fullEnv };
    delete env.GITHUB_APP_PRIVATE_KEY;
    await expect(seed({ ...base, env, exec, log: () => {} })).rejects.toThrow("github-app-private-key");
    expect(calls.some((c) => c.args.includes("add"))).toBe(false);
  });

  it("never puts a secret value in a command's arguments", async () => {
    const { exec, calls } = fakeExec({ cluster: { AUTH_SIGNING_KEY: "b".repeat(64) } });
    await seed({ ...base, env: fullEnv, exec, generate: () => "c".repeat(64), log: () => {} });
    const values = [...Object.values(fullEnv), "b".repeat(64), "c".repeat(64), "postgresql://db"];
    for (const call of calls) for (const value of values) expect(call.args.join(" ")).not.toContain(value);
    const added = calls.filter((c) => c.args.includes("add"));
    expect(added).toHaveLength(8);
    expect(added.every((c) => c.args.includes("--data-file=-") && typeof c.input === "string")).toBe(true);
  });

  it("carries over the cluster's auth key rather than generating one", async () => {
    const { exec, calls } = fakeExec({ cluster: { AUTH_SIGNING_KEY: "b".repeat(64) } });
    await seed({ ...base, env: fullEnv, exec, generate: () => "c".repeat(64), log: () => {} });
    const signing = calls.find((c) => c.args.includes("add") && c.args.includes("wardby-auth-signing-key"));
    expect(signing.input).toBe("b".repeat(64));
  });

  it("leaves secrets that already have versions alone", async () => {
    const versions = Object.fromEntries(
      SECRETS.map((s) => [`wardby-${s.id}`, s.id === "database-url" ? "postgresql://db" : "x"]),
    );
    const { exec, calls } = fakeExec({ versions });
    await seed({ ...base, env: {}, exec, generate: never, log: () => {} });
    expect(calls.some((c) => c.args.includes("add"))).toBe(false);
  });
});
