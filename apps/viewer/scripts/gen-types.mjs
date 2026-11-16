// Generates src/api/generated.ts from the server's published JSON Schemas.
// The app never imports server TypeScript source — only these JSON files.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compile } from "json-schema-to-typescript";
import { format, resolveConfig } from "prettier";

const appDir = new URL("../", import.meta.url);
const schemaDir = new URL("../../../src/viewer/schemas/", import.meta.url);
const outFile = new URL("src/api/generated.ts", appDir);

const SCHEMAS = [
  ["graph-snapshot", "GraphSnapshot"],
  ["run-detail", "RunDetail"],
  ["viewer-event", "ViewerEvent"],
  ["infra-info", "InfraInfo"],
  ["document-list", "DocumentList"],
];

const HEADER = "// Generated from src/viewer/schemas by scripts/gen-types.mjs — do not edit.\n\n";

export async function render() {
  let out = HEADER;
  for (const [file, name] of SCHEMAS) {
    const schema = JSON.parse(await readFile(new URL(`${file}.schema.json`, schemaDir), "utf8"));
    out += await compile(schema, name, {
      bannerComment: "",
      additionalProperties: false,
      strictIndexSignatures: true,
      cwd: fileURLToPath(schemaDir),
    });
    out += "\n";
  }
  const config = (await resolveConfig(fileURLToPath(new URL(".prettierrc.json", appDir)))) ?? {};
  return format(out, { ...config, parser: "typescript" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(outFile, await render());
  console.log(`wrote ${fileURLToPath(outFile)}`);
}
