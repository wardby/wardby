// Runs up.sh's own hostname check (the block from the WARDBY_HOSTNAME requirement to its `esac`)
// under bash: a missing, local, or malformed hostname must stop the deploy before anything is
// rendered, and the shell's own HOSTNAME (the machine name) must never stand in for it.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = readFileSync(fileURLToPath(new URL("./up.sh", import.meta.url)), "utf8");
const start = script.indexOf(': "${WARDBY_HOSTNAME:?');
const check = script.slice(start, script.indexOf("\nesac\n", start) + "\nesac\n".length);

const run = (env) =>
  spawnSync("bash", ["-c", `set -euo pipefail\n${check}\necho ok`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });

describe("deploy/gke/up.sh hostname", () => {
  it("is found in up.sh", () => {
    expect(start).toBeGreaterThan(0);
    expect(script).not.toMatch(/\$\{HOSTNAME[}:]/);
  });

  it("requires WARDBY_HOSTNAME, ignoring the shell's own HOSTNAME", () => {
    const result = run({ HOSTNAME: "laptop.example.com" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/set WARDBY_HOSTNAME/);
  });

  it("accepts a public DNS name", () => {
    expect(run({ WARDBY_HOSTNAME: "app.example.com" }).stdout.trim()).toBe("ok");
  });

  it.each([
    "chriss.macbook.pro.2.lan",
    "box.local",
    "host.internal",
    "localhost",
    "app",
    "https://app.example.com",
    "App.Example.com",
    "app.example.com/mcp",
  ])("refuses %s", (name) => {
    const result = run({ WARDBY_HOSTNAME: name });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ok");
  });
});

// The hostname-change check, against a fake kubectl that reports the live Gateway's hostname.
const changeStart = script.indexOf("# hostname-change check");
const changeCheck = script.slice(changeStart, script.indexOf("# end hostname-change check", changeStart));

function runChange(live, env) {
  const bin = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  const kubectl = join(bin, "kubectl");
  writeFileSync(kubectl, live === null ? "#!/bin/sh\nexit 1\n" : `#!/bin/sh\nprintf '%s' '${live}'\n`);
  chmodSync(kubectl, 0o755);
  return spawnSync("bash", ["-c", `set -euo pipefail\nNAMESPACE=wardby-coding\n${changeCheck}\necho ok`], {
    env: { PATH: `${bin}:${process.env.PATH}`, ...env },
    input: "",
    encoding: "utf8",
  });
}

describe("deploy/gke/up.sh hostname change", () => {
  it("is found in up.sh, before anything is built", () => {
    expect(changeStart).toBeGreaterThan(0);
    expect(changeStart).toBeLessThan(script.indexOf('echo "==> 3/'));
  });

  it("continues when the hostname is unchanged, or there is no live Gateway yet", () => {
    expect(runChange("app.example.com", { WARDBY_HOSTNAME: "app.example.com" }).stdout.trim()).toBe("ok");
    expect(runChange(null, { WARDBY_HOSTNAME: "app.example.com" }).stdout.trim()).toBe("ok");
  });

  it("stops a change that is not confirmed (no terminal to ask)", () => {
    const result = runChange("app.example.com", { WARDBY_HOSTNAME: "new.example.com" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("ok");
    expect(result.stderr).toMatch(/published on app\.example\.com.*move it to new\.example\.com/);
    expect(result.stderr).toMatch(/WARDBY_HOSTNAME_CHANGE=new\.example\.com/);
  });

  it("continues a change confirmed with WARDBY_HOSTNAME_CHANGE naming the new hostname, and only that", () => {
    const env = { WARDBY_HOSTNAME: "new.example.com" };
    expect(runChange("app.example.com", { ...env, WARDBY_HOSTNAME_CHANGE: "new.example.com" }).stdout.trim()).toBe(
      "ok",
    );
    expect(runChange("app.example.com", { ...env, WARDBY_HOSTNAME_CHANGE: "1" }).status).not.toBe(0);
  });
});
