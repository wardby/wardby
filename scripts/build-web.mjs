#!/usr/bin/env node
// Bundles the document page's browser app (src/web/app/documents.ts and the
// stylesheet it imports) with esbuild into dist/web-assets/: minified IIFE
// JavaScript and CSS with content-hashed names, plus manifest.json mapping the
// logical names to the hashed ones. The server (src/web/static.ts) serves only
// the files the manifest lists. Run by `npm run build` (npm run build:web).
// The bundled packages' licence notices (NOTICE's third-party section) head the
// JavaScript as a /*! */ comment, and any legal comments in the packages are kept.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** NOTICE from its third-party section on, as a comment that minifiers keep. */
async function licenceBanner() {
  const notice = await readFile(join(repoRoot, "NOTICE"), "utf8");
  const at = notice.indexOf("Third-party software");
  if (at < 0) throw new Error("build-web: NOTICE has no third-party section");
  const text = notice.slice(at).trimEnd();
  if (text.includes("*/")) throw new Error("build-web: NOTICE text cannot hold */");
  return `/*!\n${text}\n*/`;
}

export async function buildWeb({ outDir = join(repoRoot, "dist", "web-assets") } = {}) {
  // Start clean so the folder holds exactly what the manifest lists.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await build({
    entryPoints: [join(repoRoot, "src", "web", "app", "documents.ts")],
    outdir: outDir,
    entryNames: "[name]-[hash]",
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    sourcemap: false,
    legalComments: "eof",
    banner: { js: await licenceBanner() },
    metafile: true,
    logLevel: "warning",
    tsconfig: join(repoRoot, "src", "web", "app", "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  let js;
  let css;
  for (const file of Object.keys(result.metafile.outputs)) {
    const name = basename(file);
    if (/^documents-[A-Za-z0-9]+\.js$/.test(name)) js = name;
    else if (/^documents-[A-Za-z0-9]+\.css$/.test(name)) css = name;
    else throw new Error(`build-web: unexpected output ${name}`);
  }
  if (!js || !css) throw new Error("build-web: the bundle must produce documents.js and documents.css");
  const manifest = { "documents.js": js, "documents.css": css };
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const manifest = await buildWeb();
  process.stdout.write(`build-web: ${manifest["documents.js"]}, ${manifest["documents.css"]}\n`);
}
