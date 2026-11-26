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

  it("never invents the App's OAuth client credentials", () => {
    for (const [id, env] of [
      ["github-app-client-id", "GITHUB_APP_CLIENT_ID"],
      ["github-app-client-secret", "GITHUB_APP_CLIENT_SECRET"],
    ]) {
      const decision = decideSeed(entry(id), { hasVersion: false, generate: never });
      expect(decision.action).toBe("error");
      expect(decision.message).toContain(env);
    }
  });

  it("generates a webhook secret when none exists yet", () => {
    expect(decideSeed(entry("github-app-webhook-secret"), { hasVersion: false, generate: () => "g" })).toEqual({
      action: "add",
      from: "generated",
      value: "g",
    });
  });
});

describe("decideSeed for an optional secret", () => {
  it("skips a Jira value with no source and never generates one", () => {
    expect(decideSeed(entry("jira-api-token"), { hasVersion: false, generate: never })).toEqual({ action: "skip" });
  });

  it("seeds a Jira value from .env.local like any other", () => {
    expect(decideSeed(entry("jira-api-token"), { hasVersion: false, env: "e", generate: never })).toEqual({
      action: "add",
      from: ".env.local",
      value: "e",
    });
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
function fakeExec({ versions = {}, cluster }) {
  const calls = [];
  const exec = async (cmd, args, options = {}) => {
    calls.push({ cmd, args, input: options.input });
    if (cmd === "kubectl") {
      if (!cluster) return { code: 1, stdout: "", stderr: 'Error from server (NotFound): secrets "x" not found' };
      const data = Object.fromEntries(Object.entries(cluster).map(([k, v]) => [k, Buffer.from(v).toString("base64")]));
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    }
    const name = args[args.indexOf("versions") + 2];
    if (args.includes("list")) return { code: 0, stdout: versions[name] ? "1\n" : "", stderr: "" };
    if (args.includes("add")) return { code: 0, stdout: "", stderr: "" };
    throw new Error(`unexpected command ${cmd} ${args.join(" ")}`);
  };
  return { exec, calls };
}

const base = { project: "p", prefix: "wardby", context: "ctx", namespace: "wardby-coding" };
const fullEnv = {
  OPENAI_API_KEY: "sk-openai-secret",
  ANTHROPIC_API_KEY: "sk-ant-secret",
  SECRET_APP_KEY: "a".repeat(64),
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
  GITHUB_APP_CLIENT_ID: "Iv23liExampleClientId",
  GITHUB_APP_CLIENT_SECRET: "example-client-secret-value",
};
const jiraEnv = {
  WARDBY_JIRA_SITE_URL: "https://your-site.atlassian.net",
  WARDBY_JIRA_API_BASE_URL: "https://api.atlassian.com/ex/jira/00000000-0000-0000-0000-000000000000",
  WARDBY_JIRA_API_TOKEN: "jira-token-secret-value",
  WARDBY_JIRA_API_TOKEN_EXPIRES_AT: "2027-01-01",
  WARDBY_JIRA_WEBHOOK_SECRET: "jira-webhook-secret-value-0000",
};
const slackEnv = { WARDBY_SLACK_BOT_TOKEN: "xoxb-slack-token-secret-value" };
const required = SECRETS.filter((s) => !s.group);
const inGroup = (group) => SECRETS.filter((s) => s.group === group);

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
    const values = [...Object.values(fullEnv), "b".repeat(64), "c".repeat(64)];
    for (const call of calls) for (const value of values) expect(call.args.join(" ")).not.toContain(value);
    const added = calls.filter((c) => c.args.includes("add"));
    expect(added).toHaveLength(required.length);
    expect(added.every((c) => c.args.includes("--data-file=-") && typeof c.input === "string")).toBe(true);
  });

  it("carries over the cluster's auth key rather than generating one", async () => {
    const { exec, calls } = fakeExec({ cluster: { AUTH_SIGNING_KEY: "b".repeat(64) } });
    await seed({ ...base, env: fullEnv, exec, generate: () => "c".repeat(64), log: () => {} });
    const signing = calls.find((c) => c.args.includes("add") && c.args.includes("wardby-auth-signing-key"));
    expect(signing.input).toBe("b".repeat(64));
  });

  it("leaves Jira empty and reports no groups when none of it is set", async () => {
    const { exec, calls } = fakeExec({});
    const result = await seed({ ...base, env: fullEnv, exec, generate: () => "c".repeat(64), log: () => {} });
    expect(result.enabledGroups).toEqual([]);
    expect(calls.some((c) => c.args.includes("add") && c.args.some((a) => a.includes("jira")))).toBe(false);
  });

  it("seeds every Jira value and reports the group when all of it is set", async () => {
    const { exec, calls } = fakeExec({});
    const env = { ...fullEnv, ...jiraEnv };
    const result = await seed({ ...base, env, exec, generate: () => "c".repeat(64), log: () => {} });
    expect(result.enabledGroups).toEqual(["jira"]);
    expect(calls.filter((c) => c.args.includes("add"))).toHaveLength(required.length + inGroup("jira").length);
    for (const call of calls)
      for (const value of Object.values(jiraEnv)) expect(call.args.join(" ")).not.toContain(value);
  });

  it("counts a Jira value already in Secret Manager as set", async () => {
    const { exec } = fakeExec({ versions: { "wardby-jira-api-token": "x" } });
    const env = { ...fullEnv, ...jiraEnv };
    delete env.WARDBY_JIRA_API_TOKEN;
    const result = await seed({ ...base, env, exec, generate: () => "c".repeat(64), log: () => {} });
    expect(result.enabledGroups).toEqual(["jira"]);
  });

  it("writes nothing when only part of Jira is set", async () => {
    const { exec, calls } = fakeExec({});
    const env = { ...fullEnv, ...jiraEnv };
    delete env.WARDBY_JIRA_WEBHOOK_SECRET;
    await expect(seed({ ...base, env, exec, generate: () => "c".repeat(64), log: () => {} })).rejects.toThrow(
      "WARDBY_JIRA_WEBHOOK_SECRET",
    );
    expect(calls.some((c) => c.args.includes("add"))).toBe(false);
  });

  it("leaves Slack empty when its bot token is not set", async () => {
    const { exec, calls } = fakeExec({});
    const result = await seed({ ...base, env: fullEnv, exec, generate: () => "c".repeat(64), log: () => {} });
    expect(result.enabledGroups).not.toContain("slack");
    expect(calls.some((c) => c.args.includes("add") && c.args.some((a) => a.includes("slack")))).toBe(false);
  });

  it("seeds the Slack bot token over stdin and reports the group when it is set", async () => {
    const { exec, calls } = fakeExec({});
    const env = { ...fullEnv, ...slackEnv };
    const result = await seed({ ...base, env, exec, generate: () => "c".repeat(64), log: () => {} });
    expect(result.enabledGroups).toEqual(["slack"]);
    const added = calls.find((c) => c.args.includes("add") && c.args.includes("wardby-slack-bot-token"));
    expect(added.input).toBe(slackEnv.WARDBY_SLACK_BOT_TOKEN);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(slackEnv.WARDBY_SLACK_BOT_TOKEN);
  });

  it("seeds the live-editing Redis URL over stdin and reports its group only when it is set", async () => {
    const redisEnv = { WARDBY_LIVE_REDIS_URL: "rediss://default:redis-secret-value@cache:6380" };
    const unset = fakeExec({});
    const without = await seed({
      ...base,
      env: fullEnv,
      exec: unset.exec,
      generate: () => "c".repeat(64),
      log: () => {},
    });
    expect(without.enabledGroups).not.toContain("live-redis");
    const { exec, calls } = fakeExec({});
    const result = await seed({
      ...base,
      env: { ...fullEnv, ...redisEnv },
      exec,
      generate: () => "c".repeat(64),
      log: () => {},
    });
    expect(result.enabledGroups).toEqual(["live-redis"]);
    const added = calls.find((c) => c.args.includes("add") && c.args.includes("wardby-live-redis-url"));
    expect(added.input).toBe(redisEnv.WARDBY_LIVE_REDIS_URL);
    for (const call of calls) expect(call.args.join(" ")).not.toContain("redis-secret-value");
  });

  it("reports Jira and Slack together when both are set", async () => {
    const { exec } = fakeExec({});
    const env = { ...fullEnv, ...jiraEnv, ...slackEnv };
    const result = await seed({ ...base, env, exec, generate: () => "c".repeat(64), log: () => {} });
    expect(result.enabledGroups).toEqual(["jira", "slack"]);
  });

  it("leaves secrets that already have versions alone", async () => {
    const versions = Object.fromEntries(SECRETS.map((s) => [`wardby-${s.id}`, "x"]));
    const { exec, calls } = fakeExec({ versions });
    await seed({ ...base, env: {}, exec, generate: never, log: () => {} });
    expect(calls.some((c) => c.args.includes("add"))).toBe(false);
  });
});
