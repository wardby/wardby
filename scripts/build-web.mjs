#!/usr/bin/env node
// Bundles the browser apps (src/web/app/documents.ts and designs.ts, and the
// stylesheets they import) with esbuild into dist/web-assets/: minified IIFE
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

const ENTRIES = ["documents", "designs"];

/** The browser-bundle notices: from their heading to the end of NOTICE, as a comment minifiers keep. */
async function licenceBanner() {
  const notice = await readFile(join(repoRoot, "NOTICE"), "utf8");
  const at = notice.indexOf("Third-party software in the browser bundles");
  if (at < 0) throw new Error("build-web: NOTICE has no browser-bundle section");
  const text = notice.slice(at).trimEnd();
  if (text.includes("*/")) throw new Error("build-web: NOTICE text cannot hold */");
  return `/*!\n${text}\n*/`;
}

/** npm package names among esbuild's inputs (node_modules/<name>/… or node_modules/@scope/name/…). */
function bundledPackages(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

export async function buildWeb({ outDir = join(repoRoot, "dist", "web-assets") } = {}) {
  // Start clean so the folder holds exactly what the manifest lists.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  const result = await build({
    entryPoints: ENTRIES.map((name) => join(repoRoot, "src", "web", "app", `${name}.ts`)),
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
    // GrapesJS's stylesheet embeds its icon font: inline it so the manifest stays four files.
    loader: { ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl", ".eot": "dataurl", ".svg": "dataurl" },
    metafile: true,
    logLevel: "warning",
    tsconfig: join(repoRoot, "src", "web", "app", "tsconfig.json"),
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const manifest = {};
  for (const file of Object.keys(result.metafile.outputs)) {
    const name = basename(file);
    const m = /^(documents|designs)-[A-Za-z0-9]+\.(js|css)$/.exec(name);
    if (!m) throw new Error(`build-web: unexpected output ${name}`);
    manifest[`${m[1]}.${m[2]}`] = name;
  }
  for (const entry of ENTRIES) {
    for (const ext of ["js", "css"]) {
      if (!manifest[`${entry}.${ext}`]) throw new Error(`build-web: the bundle must produce ${entry}.${ext}`);
    }
  }
  await writeFile(join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifest, packages: bundledPackages(result.metafile) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { manifest } = await buildWeb();
  process.stdout.write(`build-web: ${Object.values(manifest).join(", ")}\n`);
}
