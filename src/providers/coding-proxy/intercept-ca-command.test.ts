import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { interceptCaCommand } from "./intercept-ca-command.js";
import { loadInterceptCa } from "./tunnel-ca.js";

describe("wardby coding intercept-ca", () => {
  let directory: string;
  let output: string;
  const write = (text: string) => void (output += text);

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "intercept-ca-command-"));
    output = "";
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("writes a CA the proxy accepts, with the key readable by its owner only, and prints no key text", async () => {
    const out = join(directory, "ca");
    expect(
      await interceptCaCommand(["--host", "registry.example.com", "--host", "other.example.com", "--out", out], write),
    ).toBe(0);
    const certificatePem = await readFile(join(out, "ca.crt"), "utf8");
    const privateKeyPem = await readFile(join(out, "ca.key"), "utf8");
    expect((await stat(join(out, "ca.key"))).mode & 0o777).toBe(0o600);
    const ca = await loadInterceptCa({
      certificatePem,
      privateKeyPem,
      hosts: ["registry.example.com", "other.example.com"],
    });
    expect(ca.hosts).toEqual(["registry.example.com", "other.example.com"]);
    expect(output).toContain(join(out, "ca.crt"));
    expect(output).not.toContain("PRIVATE KEY");
    expect(output).not.toContain("BEGIN CERTIFICATE");
  });

  it("writes a CA with no name constraint on request, warns, and takes no host with it", async () => {
    const out = join(directory, "open");
    expect(await interceptCaCommand(["--unconstrained", "--out", out], write)).toBe(0);
    const ca = await loadInterceptCa({
      certificatePem: await readFile(join(out, "ca.crt"), "utf8"),
      privateKeyPem: await readFile(join(out, "ca.key"), "utf8"),
      hosts: ["registry.example.com"],
    });
    expect(ca.constrained).toBe(false);
    expect(output).toContain("no name constraint");
    expect(output).not.toContain("PRIVATE KEY");
    output = "";
    expect(
      await interceptCaCommand(["--unconstrained", "--host", "registry.example.com", "--out", directory], write),
    ).toBe(2);
    expect(output).toContain("usage:");
  });

  it("never overwrites an existing CA", async () => {
    const args = ["--host", "registry.example.com", "--out", directory];
    expect(await interceptCaCommand(args, write)).toBe(0);
    const before = await readFile(join(directory, "ca.key"), "utf8");
    output = "";
    expect(await interceptCaCommand(args, write)).toBe(1);
    expect(output).toContain("nothing was overwritten");
    expect(await readFile(join(directory, "ca.key"), "utf8")).toBe(before);
  });

  it("refuses missing arguments, IP literals and a bad validity with a message", async () => {
    expect(await interceptCaCommand([], write)).toBe(2);
    expect(await interceptCaCommand(["--bogus"], write)).toBe(2);
    expect(await interceptCaCommand(["--host", "10.0.0.1", "--out", directory], write)).toBe(1);
    expect(
      await interceptCaCommand(["--host", "registry.example.com", "--out", directory, "--days", "soon"], write),
    ).toBe(1);
    expect(output).toContain("usage:");
    expect(output).toContain("bare hostnames");
    expect(output).toContain("positive number of days");
  });
});
