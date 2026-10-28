// Runs up.sh's WARDBY_SESSION_TRANSCRIPTS check and the control-plane env
// injection under bash: off by default (no blob-store env at all), on adds the
// blob store and retention to the control plane only -- never the coding
// proxy -- and anything else stops the deploy before anything is rendered.
// Also pins the Terraform the injection relies on: a bucket of its own, a
// lifecycle rule on run-transcripts/ for the same retention, and access for
// the control plane's service account only.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
const script = read("up.sh");
const section = (name) => {
  const start = `# --- ${name} ---`;
  const end = `# --- end ${name} ---`;
  return script.slice(script.indexOf(start), script.indexOf(end) + end.length);
};
const cacheCheck = section("WARDBY_DEPENDENCY_CACHE check");
const cacheInject = section("WARDBY_DEPENDENCY_CACHE proxy env");
const check = section("WARDBY_SESSION_TRANSCRIPTS check");
const inject = section("WARDBY_SESSION_TRANSCRIPTS control-plane env");

const run = (env, body = "") =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${cacheCheck}\n${check}\n${body}\necho ok`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

// A cut-down render with both containers, each with its own anchor.
const PROXY = [
  "      containers:",
  "        - name: proxy",
  "          env:",
  "            - name: DATABASE_URL",
  "              value: wardby-proxy-database-url",
  "            - name: NODE_ENV",
  "              value: production",
].join("\n");
const CONTROL_PLANE = [
  "      containers:",
  "        - name: control-plane",
  "          env:",
  "            - name: WARDBY_MOBILE_ENABLED",
  "              value: wardby_mobile_enabled",
  "            - name: NODE_ENV",
  "              value: production",
].join("\n");
const RENDERED = `${PROXY}\n---\n${CONTROL_PLANE}\n`;

const render = (env) =>
  run(
    { SESSION_TRANSCRIPTS_RETENTION_DAYS: "30", RENDERED, ...env },
    [
      'DEPENDENCY_CACHE_BUCKET="${DEPENDENCY_CACHE_BUCKET:-}"',
      'SESSION_TRANSCRIPTS_BUCKET="${SESSION_TRANSCRIPTS_BUCKET:-}"',
      'SESSION_TRANSCRIPTS_RETENTION_DAYS="${SESSION_TRANSCRIPTS_RETENTION_DAYS:-}"',
      cacheInject,
      inject,
      `printf '%s' "$RENDERED" | inject_dependency_cache_env | inject_session_transcripts_env`,
    ].join("\n"),
  );

/** The rendered text of each document, split on the separator. */
const documents = (stdout) => {
  const [proxy, controlPlane] = stdout.slice(stdout.indexOf("      containers:")).split("\n---\n");
  return { proxy, controlPlane };
};

describe("deploy/gke/up.sh WARDBY_SESSION_TRANSCRIPTS", () => {
  it("has both sections, in the apply step, with the bucket and retention read from terraform", () => {
    expect(check).toContain("WARDBY_SESSION_TRANSCRIPTS");
    expect(inject).toContain("RUN_TRANSCRIPT_RETENTION_DAYS");
    expect(script).toContain("output -raw session_transcripts_bucket");
    expect(script).toContain("output -raw session_transcripts_retention_days");
    expect(script).toContain("| inject_session_transcripts_env \\");
    // The injection runs before the placeholder check, so its anchor is still in the render.
    expect(script.indexOf("| inject_session_transcripts_env \\")).toBeLessThan(
      script.indexOf('assert_no_placeholders "$OVERLAY_MANIFEST"'),
    );
  });

  it("is off by default: unset, empty and false say off and leave the render alone", () => {
    for (const env of [{}, { WARDBY_SESSION_TRANSCRIPTS: "" }, { WARDBY_SESSION_TRANSCRIPTS: "false" }]) {
      const result = render({ ...env, SESSION_TRANSCRIPTS_BUCKET: "my-transcripts" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("session transcripts are off");
      expect(result.stdout).not.toMatch(/BLOB_STORE|RUN_TRANSCRIPT|my-transcripts/);
      expect(result.stdout).toContain(RENDERED);
    }
  });

  it("when true, adds the blob store and retention to the control plane, indented to match", () => {
    const result = render({ WARDBY_SESSION_TRANSCRIPTS: "true", SESSION_TRANSCRIPTS_BUCKET: "my-transcripts" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("session transcripts are on");
    const { proxy, controlPlane } = documents(result.stdout);
    expect(controlPlane).toContain(
      [
        "              value: wardby_mobile_enabled",
        "            - name: BLOB_STORE",
        '              value: "gcs"',
        "            - name: BLOB_STORE_GCS_BUCKET",
        '              value: "my-transcripts"',
        "            - name: RUN_TRANSCRIPT_RETENTION_DAYS",
        '              value: "30"',
        "            - name: NODE_ENV",
      ].join("\n"),
    );
    expect(controlPlane).not.toContain("RUN_TRANSCRIPT_MAX_BYTES");
    // The proxy gets nothing: no blob store, no bucket, no transcript setting.
    expect(proxy).toBe(PROXY);
  });

  it("keeps the two buckets apart when the dependency cache is on as well", () => {
    const result = render({
      WARDBY_DEPENDENCY_CACHE: "true",
      DEPENDENCY_CACHE_BUCKET: "my-cache",
      WARDBY_SESSION_TRANSCRIPTS: "true",
      SESSION_TRANSCRIPTS_BUCKET: "my-transcripts",
    });
    expect(result.status).toBe(0);
    const { proxy, controlPlane } = documents(result.stdout);
    expect(proxy).toContain('value: "my-cache"');
    expect(proxy).not.toMatch(/my-transcripts|RUN_TRANSCRIPT/);
    expect(controlPlane).toContain('value: "my-transcripts"');
    expect(controlPlane).not.toMatch(/my-cache|WARDBY_DEPENDENCY_CACHE/);
  });

  it("passes the retention terraform reports and an optional size cap", () => {
    const result = render({
      WARDBY_SESSION_TRANSCRIPTS: "true",
      SESSION_TRANSCRIPTS_BUCKET: "my-transcripts",
      SESSION_TRANSCRIPTS_RETENTION_DAYS: "90",
      RUN_TRANSCRIPT_MAX_BYTES: "20971520",
    });
    expect(result.status).toBe(0);
    const { controlPlane } = documents(result.stdout);
    expect(controlPlane).toContain('- name: RUN_TRANSCRIPT_RETENTION_DAYS\n              value: "90"');
    expect(controlPlane).toContain('- name: RUN_TRANSCRIPT_MAX_BYTES\n              value: "20971520"');
  });

  it("stops when true but terraform has no bucket", () => {
    const result = render({ WARDBY_SESSION_TRANSCRIPTS: "true", SESSION_TRANSCRIPTS_BUCKET: "" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/session_transcripts_enabled/);
  });

  it("stops when terraform's retention is not a whole number from 1 to 3650", () => {
    for (const days of ["", "0", "3651", "07", "1.5", 'x"\n  - evil']) {
      const result = render({
        WARDBY_SESSION_TRANSCRIPTS: "true",
        SESSION_TRANSCRIPTS_BUCKET: "my-transcripts",
        SESSION_TRANSCRIPTS_RETENTION_DAYS: days,
      });
      expect(result.status, days).not.toBe(0);
      expect(result.stderr).toMatch(/session_transcripts_retention_days/);
    }
  });

  it("rejects anything but true or false", () => {
    for (const bad of ["TRUE", "1", "yes", "on"]) {
      const result = run({ WARDBY_SESSION_TRANSCRIPTS: bad });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/WARDBY_SESSION_TRANSCRIPTS must be true or false/);
    }
  });

  it("rejects a size cap outside 1 MiB to 64 MiB", () => {
    for (const bad of ["1048575", "67108865", "010485760", "10MiB", "-1"]) {
      const result = run({ WARDBY_SESSION_TRANSCRIPTS: "true", RUN_TRANSCRIPT_MAX_BYTES: bad });
      expect(result.status, bad).not.toBe(0);
      expect(result.stderr).toMatch(/RUN_TRANSCRIPT_MAX_BYTES must be an integer between 1048576 and 67108864/);
    }
    for (const good of ["1048576", "67108864"]) {
      expect(run({ WARDBY_SESSION_TRANSCRIPTS: "true", RUN_TRANSCRIPT_MAX_BYTES: good }).status, good).toBe(0);
    }
  });

  it("rejects a bucket name that is not a bucket name (no injection into the manifest)", () => {
    const result = render({ WARDBY_SESSION_TRANSCRIPTS: "true", SESSION_TRANSCRIPTS_BUCKET: 'x"\n  - evil' });
    expect(result.status).not.toBe(0);
  });
});

describe("deploy/gke session transcripts Terraform", () => {
  const tf = read("session-transcripts.tf");

  it("creates nothing unless session_transcripts_enabled", () => {
    const counts = [...tf.matchAll(/^ {2}count = (.+)$/gm)].map((m) => m[1]);
    expect(counts).toEqual(["var.session_transcripts_enabled ? 1 : 0", "var.session_transcripts_enabled ? 1 : 0"]);
  });

  it("is a bucket of its own, private, that deletes run-transcripts/ after the retention days", () => {
    expect(tf).toContain("name     = var.session_transcripts_bucket_name");
    expect(tf).toContain('public_access_prevention    = "enforced"');
    expect(tf).toContain("uniform_bucket_level_access = true");
    expect(tf).toContain("age            = var.session_transcripts_retention_days");
    expect(tf).toContain('matches_prefix = ["run-transcripts/"]');
    expect(tf).toContain("var.session_transcripts_bucket_name != var.dependency_cache_bucket_name");
  });

  it("grants the control plane's service account, and nothing else, access", () => {
    const members = [...tf.matchAll(/member = "(.+)"/g)].map((m) => m[1]);
    expect(members).toEqual(['serviceAccount:${google_service_account.database["app"].email}']);
    expect(tf).not.toMatch(/database\["(proxy|gateway|migrator)"\]/);
    // And the dependency cache bucket stays the proxy's only.
    expect(read("dependency-cache.tf")).not.toMatch(/session_transcripts|database\["app"\]/);
  });

  it("outputs what up.sh reads", () => {
    const outputs = read("outputs.tf");
    expect(outputs).toContain('output "session_transcripts_bucket"');
    expect(outputs).toContain('output "session_transcripts_retention_days"');
  });
});
