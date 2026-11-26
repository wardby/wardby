import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { modulesMissingFromImage, relativeImportClosure } from "../coding-worker/image-closure.test-support.js";

const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
/** One Dockerfile stage's text, from its FROM line to the next. */
function stage(dockerfile: string, name: string): string {
  const start = dockerfile.indexOf(` AS ${name}\n`);
  const next = dockerfile.indexOf("\nFROM ", start + 1);
  return dockerfile.slice(start, next === -1 ? undefined : next);
}

describe("Gemini CLI coding worker image policy", () => {
  it("pins every external base by digest and builds the plain Node image by default", async () => {
    const dockerfile = await read("./Dockerfile");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    const stages = new Set(from.map((line) => line.split(/\s+/).at(-1)));
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line) || stages.has(line.split(/\s+/)[1]))).toBe(true);
    expect(from.at(-1)).toMatch(/ AS runtime$/);
    expect(dockerfile).toContain(" AS node-python\n");
  });

  it("installs the CLI only from the lockfile, never globally, and never trusts the workspace", async () => {
    const dockerfile = await read("./Dockerfile");
    expect(dockerfile).toContain(
      "COPY src/gemini-coding-worker/package.json src/gemini-coding-worker/package-lock.json ./",
    );
    expect(dockerfile).toContain("npm ci --omit=dev --ignore-scripts");
    expect(dockerfile).not.toMatch(/npm install[^\n]*gemini-cli/);
    expect(dockerfile).not.toContain("GEMINI_CLI_TRUST_WORKSPACE");
    expect(dockerfile).toMatch(/test "\$\(HOME=\/tmp\/gemini-version node [^"]*gemini\.js --version\)" = "0\.70\.0"/);
  });

  it("bakes the system settings root-owned and read-only, and checks them at build", async () => {
    const dockerfile = await read("./Dockerfile");
    expect(dockerfile).toContain("COPY src/gemini-coding-worker/system-settings.json /etc/gemini-cli/settings.json");
    expect(dockerfile).toContain(
      "COPY src/gemini-coding-worker/policies/wardby.toml /etc/gemini-cli/policies/wardby.toml",
    );
    expect(dockerfile).toContain("chown -R root:root /etc/gemini-cli");
    expect(dockerfile).toContain("chmod 0755 /etc/gemini-cli /etc/gemini-cli/policies");
    expect(dockerfile).toContain("chmod 0644 /etc/gemini-cli/settings.json /etc/gemini-cli/policies/wardby.toml");
    expect(dockerfile).toContain("verifyGeminiSystemSettings()");
    // Only those two files go into /etc/gemini-cli (the driver checks its exact contents).
    const intoSystemDir = [...dockerfile.matchAll(/^COPY [^\n]*?(\/etc\/gemini-cli\S*)$/gm)].map((m) => m[1]);
    expect(intoSystemDir).toEqual(["/etc/gemini-cli/settings.json", "/etc/gemini-cli/policies/wardby.toml"]);
  });

  it("runs as the worker user in its own pid namespace, has the Codex worker's shims, and no privileged host tooling", async () => {
    const dockerfile = await read("./Dockerfile");
    for (const target of ["runtime", "node-python"]) {
      const text = stage(dockerfile, target);
      expect(text, target).toContain("USER 10001:10001");
      expect(text, target).toContain('ENTRYPOINT ["node", "/opt/wardby/gemini-coding-worker/main.js"]');
      expect(text, target).toContain("HOME=/home/wardby");
      // The driver's leftover-process sweep runs only with this set (leftovers.ts).
      expect(text, target).toMatch(/^ENV [^\n]*\bWARDBY_WORKER_PID_NAMESPACE=1\b/m);
      for (const executable of ["ssh", "curl", "wget", "sudo", "gcc", "make"]) {
        expect(text, `${target} ${executable}`).toContain(`test ! -e /usr/bin/${executable}`);
      }
    }
    for (const line of [
      "COPY src/coding-worker/npm-shim.mjs ./bin/npm-shim.mjs",
      "ln -s npm-shim.mjs /opt/wardby/bin/pnpm",
      "/etc/profile.d/wardby-shims.sh",
      "COPY src/coding-worker/dependency-cache.mjs ./coding-worker/dependency-cache.mjs",
      "COPY src/coding-worker/result-bundle.mjs ./coding-worker/result-bundle.mjs",
      "COPY src/coding-worker/plan-folder.mjs ./coding-worker/plan-folder.mjs",
      "COPY src/coding-worker/uv-shim.mjs ./coding-worker/uv-shim.mjs",
      "COPY --from=command-agent /wardby-cmd /opt/wardby/bin/wardby-cmd",
    ]) {
      expect(dockerfile).toContain(line);
    }
  });

  it("pins the Python layer exactly as the Codex node-python image does", async () => {
    const gemini = stage(await read("./Dockerfile"), "node-python");
    const codex = await read("../coding-worker/Dockerfile.node-python");
    const pins = (text: string) => ({
      tools: /pytest==[\d.]+ ruff==[\d.]+ uv==[\d.]+ poetry==[\d.]+/.exec(text)?.[0],
      pythons: /uv python install --no-bin ([\d. ]+)/.exec(text)?.[1]?.trim(),
      pip: /--upgrade pip==([\d.]+)/.exec(text)?.[1],
      defaultPython: /ARG PYTHON_DEFAULT_VERSION=([\d.]+)/.exec(text)?.[1],
    });
    expect(pins(gemini)).toEqual(pins(codex));
    expect(pins(gemini).tools).toBeDefined();
  });

  it("copies every module the entry point imports", async () => {
    const dockerfile = await read("./Dockerfile");
    const closure = relativeImportClosure(["gemini-coding-worker/main.ts"]);
    expect(closure).toContain("coding-worker/run-frame.ts");
    expect(modulesMissingFromImage(dockerfile, closure)).toEqual([]);
  });

  it("loads every driver module at build time (main.js runs on import, so not main itself)", async () => {
    const dockerfile = await read("./Dockerfile");
    const smoke = /\[([^\]]*)\]\.map\(\(name\) => import\(`\/opt\/wardby\/gemini-coding-worker\//.exec(dockerfile);
    expect(smoke).not.toBeNull();
    const imported = new Set([...smoke![1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]));
    const modules = (await readdir(new URL(".", import.meta.url)))
      .filter((name) => name.endsWith(".ts") && !/\.test(-support)?\.ts$/.test(name) && name !== "main.ts")
      .map((name) => name.replace(/\.ts$/, ""));
    expect(modules.filter((name) => !imported.has(name))).toEqual([]);
    // And every shared module the driver's closure reaches.
    const shared = relativeImportClosure(["gemini-coding-worker/main.ts"])
      .filter((path) => path.startsWith("coding-worker/") && path.endsWith(".ts"))
      .map((path) => path.slice("coding-worker/".length, -".ts".length));
    const sharedSmoke = /\[([^\]]*)\]\.map\(\(name\) => import\(`\/opt\/wardby\/coding-worker\//.exec(dockerfile);
    expect(sharedSmoke).not.toBeNull();
    const sharedImported = new Set([...sharedSmoke![1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]));
    expect(shared.filter((name) => !sharedImported.has(name))).toEqual([]);
  });
});
