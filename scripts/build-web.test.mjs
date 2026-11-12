// Builds both browser bundles into a temp dir: four outputs, the licence banner on each script,
// and every npm package esbuild bundled is named in NOTICE.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildWeb } from "./build-web.mjs";

describe("scripts/build-web.mjs", () => {
  const dirs = [];
  afterAll(async () => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it("bundles documents and designs and names every bundled package in NOTICE", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "build-web-"));
    dirs.push(outDir);
    const { manifest, packages } = await buildWeb({ outDir });
    expect(Object.keys(manifest).sort()).toEqual(["designs.css", "designs.js", "documents.css", "documents.js"]);
    const notice = await readFile(new URL("../NOTICE", import.meta.url), "utf8");
    expect(packages).toContain("grapesjs");
    expect(packages).toContain("grapesjs-parser-postcss");
    for (const name of packages) expect(notice, `NOTICE must name ${name}`).toContain(name);
    const designs = await readFile(join(outDir, manifest["designs.js"]), "utf8");
    expect(designs.startsWith("/*!")).toBe(true);
    expect(designs).toContain("BSD 3-Clause");
    const documents = await readFile(join(outDir, manifest["documents.js"]), "utf8");
    expect(documents).not.toContain("grapesjs.com"); // GrapesJS only in the designs bundle
    // Subresource Integrity: integrity.json beside the manifest, keyed like it, sha384 of each output's bytes.
    const integrity = JSON.parse(await readFile(join(outDir, "integrity.json"), "utf8"));
    expect(Object.keys(integrity).sort()).toEqual(Object.keys(manifest).sort());
    for (const [key, file] of Object.entries(manifest)) {
      const digest = createHash("sha384")
        .update(await readFile(join(outDir, file)))
        .digest("base64");
      expect(integrity[key]).toBe(`sha384-${digest}`);
    }
    // The manifest itself stays exactly the four file names (static.ts serves only those).
    const onDisk = JSON.parse(await readFile(join(outDir, "manifest.json"), "utf8"));
    expect(onDisk).toEqual(manifest);
  }, 120_000);
});
