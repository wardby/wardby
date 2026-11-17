import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

describe("native worker image policy", () => {
  it("pins every stage by digest, installs production dependencies only, and runs as a non-root node entrypoint", async () => {
    const dockerfile = await read("./Dockerfile");
    const from = dockerfile.split("\n").filter((line) => line.startsWith("FROM "));
    expect(from.length).toBeGreaterThan(1);
    expect(from.every((line) => /@sha256:[0-9a-f]{64}/.test(line))).toBe(true);
    expect(dockerfile).toContain("npm ci --omit=dev");
    expect(dockerfile).not.toMatch(/npm install(?!.*--package-lock)/);
    expect(dockerfile).toContain("USER 10001:10001");
    expect(dockerfile).toContain('ENTRYPOINT ["node", "/opt/wardby/native-worker/main.js"]');
    expect(dockerfile).toContain("test ! -e");
    // Never the server: no Prisma client, config, or provider adapters in the image.
    expect(dockerfile).not.toMatch(/dist\/(generated|config|providers\/(secrets|datastore|executor|jobs))/);
    // Substrate mode: the four bridge modules it loads, and nothing of the server's Substrate client.
    expect(dockerfile).toContain("./substrate-bridge/");
    expect(dockerfile).toContain('"substrate-mode"');
    expect(dockerfile).not.toMatch(/dist\/providers\/substrate/);
  });

  it("pins its runtime dependencies exactly, at the versions the server's own lockfile resolves", async () => {
    const pkg = JSON.parse(await read("./package.json")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(await read("./package-lock.json")) as {
      packages: Record<string, { version?: string; integrity?: string }>;
    };
    const rootLock = JSON.parse(await read("../../package-lock.json")) as {
      packages: Record<string, { version?: string }>;
    };
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(lock.packages[`node_modules/${name}`]).toMatchObject({ version, integrity: expect.any(String) });
      expect(rootLock.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });
});
