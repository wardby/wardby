/** Writes src/viewer/schemas/<name>.schema.json from VIEWER_SCHEMAS (npm run build:viewer-schemas). */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VIEWER_SCHEMAS } from "./api-schema.js";
import { viewerJsonSchema } from "./api-schema.js";
import { OPENAPI_PATH, renderViewerOpenApi } from "./openapi.js";

export const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "schemas");

export function renderSchemas(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(VIEWER_SCHEMAS).map(([name, schema]) => [
      `${name}.schema.json`,
      `${JSON.stringify(
        {
          $ref: `#/definitions/${name}`,
          definitions: { [name]: viewerJsonSchema(schema) },
          $schema: "http://json-schema.org/draft-07/schema#",
        },
        null,
        2,
      )}\n`,
    ]),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(SCHEMA_DIR, { recursive: true });
  for (const [file, text] of Object.entries(renderSchemas())) await writeFile(join(SCHEMA_DIR, file), text);
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  await writeFile(OPENAPI_PATH, renderViewerOpenApi(pkg.version));
}
