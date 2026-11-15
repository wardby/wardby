// The optional export renderer in deploy/gke/up.sh: the WARDBY_RENDERER switch, the control-plane
// env injection, the apply/delete of the renderer manifests, the low-power stamp, the bake target
// and the ECR repository.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const script = read("./up.sh");
const section = (name) => {
  const start = `# --- ${name} ---`;
  const end = `# --- end ${name} ---`;
  expect(script).toContain(start);
  return script.slice(script.indexOf(start), script.indexOf(end) + end.length);
};
const check = section("WARDBY_RENDERER check");
const inject = section("WARDBY_RENDERER control-plane env");
const placeholderCheck = script.slice(
  script.indexOf("assert_no_placeholders() {"),
  script.indexOf("\n}\n", script.indexOf("assert_no_placeholders() {")),
);
const URL_VALUE = "http://wardby-renderer.wardby-coding.svc.cluster.local:8796";

const runCheck = (env) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${check}\necho ok`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

const RENDERED = [
  "      containers:",
  "        - name: control-plane",
  "          env:",
  "            - name: WARDBY_MOBILE_ENABLED",
  "              value: wardby_mobile_enabled",
  "            - name: NODE_ENV",
  "              value: production",
  "",
].join("\n");
const runInject = (renderer) =>
  spawnSync(
    "bash",
    ["-c", `set -euo pipefail\nWARDBY_RENDERER=${renderer}\n${inject}\nprintf '%s' "$RENDERED" | inject_renderer_env`],
    { env: { PATH: process.env.PATH, RENDERED }, encoding: "utf8" },
  );

describe("deploy/gke/up.sh WARDBY_RENDERER", () => {
  it("is documented in the header and checked before anything is rendered", () => {
    expect(script.split("\n").slice(0, 30).join("\n")).toMatch(
      /#\s+WARDBY_RENDERER=true\s+# optional: PNG\/PDF export renderer/,
    );
    expect(script.indexOf("# --- WARDBY_RENDERER check ---")).toBeGreaterThan(
      script.indexOf("# --- end WARDBY_MOBILE_ENABLED check ---"),
    );
  });

  it("accepts unset, empty and false (off) and true (on), and says which", () => {
    for (const env of [{}, { WARDBY_RENDERER: "" }, { WARDBY_RENDERER: "false" }]) {
      const r = runCheck(env);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("up.sh: export renderer is off.");
    }
    const on = runCheck({ WARDBY_RENDERER: "true" });
    expect(on.status).toBe(0);
    expect(on.stdout).toContain("up.sh: export renderer is on.");
  });

  it("exits 1 on anything else", () => {
    for (const bad of ["TRUE", "1", "yes", "wardby-renderer-image"]) {
      const r = runCheck({ WARDBY_RENDERER: bad });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/WARDBY_RENDERER/);
    }
  });
});

describe("inject_renderer_env", () => {
  it("adds WARDBY_RENDERER_URL after the control plane's mobile entry only when on", () => {
    const r = runInject("true");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(
      RENDERED.replace(
        "              value: wardby_mobile_enabled\n",
        `              value: wardby_mobile_enabled\n            - name: WARDBY_RENDERER_URL\n              value: "${URL_VALUE}"\n`,
      ),
    );
  });

  it("passes the input through unchanged when off", () => {
    const r = runInject("false");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(RENDERED);
  });

  it("is in the overlay pipeline", () => {
    expect(script).toContain("| inject_renderer_env \\");
  });
});

describe("renderer manifests in up.sh", () => {
  it("applies the gvisor overlay with the image substituted and checked when on", () => {
    expect(script).toContain("deploy/kind-coding/manifests/renderer/gvisor");
    expect(script).toMatch(/s\|image: wardby-renderer-image\|image: \$\{RENDERER_IMAGE\}\|/);
    expect(script).toMatch(/assert_no_placeholders "\$RENDERER_MANIFEST"/);
    expect(script).toContain('RENDERER_IMAGE="$(digest_of renderer)"');
    expect(script).toMatch(/docker buildx bake -f deploy\/gke\/docker-bake\.hcl renderer --load/);
  });

  it("deletes the renderer's objects when off", () => {
    expect(script).toContain(
      'kubectl -n "$NAMESPACE" delete deploy/wardby-renderer svc/wardby-renderer networkpolicy/wardby-renderer networkpolicy/wardby-control-plane-renderer-egress --ignore-not-found',
    );
  });

  it("stamps the renderer in the low-power pre-apply loop and waits for it only when on and not low-power", () => {
    expect(script).toMatch(/for low_power_target in [^;]*wardby-renderer; do/);
    expect(script).toMatch(
      /WARDBY_RENDERER" = true \] && \[ "\$LOW_POWER" = 0 \][\s\S]{0,120}rollout status deploy\/wardby-renderer --timeout=300s/,
    );
  });

  it("assert_no_placeholders catches an unsubstituted renderer image", () => {
    expect(placeholderCheck).toContain("image: wardby-renderer-image");
    const r = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\n${placeholderCheck}\n}\nassert_no_placeholders "$MANIFEST"`],
      { env: { PATH: process.env.PATH, MANIFEST: "        image: wardby-renderer-image\n" }, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("image: wardby-renderer-image");
    const ok = spawnSync(
      "bash",
      ["-c", `set -euo pipefail\n${placeholderCheck}\n}\nassert_no_placeholders "$MANIFEST"`],
      {
        env: { PATH: process.env.PATH, MANIFEST: "        image: region-docker.pkg.dev/p/r/renderer@sha256:abc\n" },
        encoding: "utf8",
      },
    );
    expect(ok.status).toBe(0);
  });
});

describe("renderer image build targets", () => {
  it("docker-bake.hcl has a renderer target outside the default group", () => {
    const bake = read("./docker-bake.hcl");
    const group = bake.match(/group "default"\s*\{[\s\S]*?targets\s*=\s*\[([\s\S]*?)\]/)[1];
    expect(group).not.toContain('"renderer"');
    const target = bake.match(/target "renderer"\s*\{([\s\S]*?)\n\}/)[1];
    expect(target).toMatch(/target\s*=\s*"renderer"/);
    expect(target).toMatch(/dockerfile\s*=\s*"deploy\/Dockerfile"/);
    expect(target).toMatch(/\$\{REGISTRY\}\/renderer:latest/);
  });

  it("deploy/aws/ecr.tf lists renderer", () => {
    const ecr = read("../aws/ecr.tf");
    const body = ecr.match(/image_names\s*=\s*toset\(\[([\s\S]*?)\]\)/)[1];
    expect(body).toContain('"renderer"');
  });
});
