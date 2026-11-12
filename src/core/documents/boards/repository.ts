import { redactTokenShapedValues } from "../../../coding/protocol.js";
import type { Executor } from "../../../providers/executor/types.js";
import { designFilePath } from "../agent-link.js";
import {
  BOARD_MAX_BYTES,
  BRAND_MAX_BYTES,
  BRAND_PATH,
  BoardFormatError,
  MANIFEST_PATH,
  parseManifest,
} from "./format.js";

const MANIFEST_READ_BYTES = 64 * 1024;
const TOO_LARGE = /^(github|local)_file_too_large$/;
const NOT_TEXT = /^(github|local)_file_(not_utf8|not_a_file)$/;

/**
 * A design's files at `ref` in a repository. Repository content is agent output: token shapes are
 * redacted here, and the format adapter redacts exact secret values when it prepares the files.
 * Errors name only a board id or a fixed code, never a path or file text.
 */
export async function readDesignFromRepository(
  executor: Pick<Executor, "readCodingRepositoryFile">,
  input: { repository: string; dir: string; ref: string },
): Promise<Record<string, string>> {
  const read = executor.readCodingRepositoryFile?.bind(executor);
  if (!read) throw new Error("document_repo_link_invalid");
  // `what` is the board id, or null for manifest.json / brand.md.
  const at = async (file: string, maxBytes: number, what: string | null): Promise<string | null> => {
    try {
      return await read({
        repository: input.repository,
        baseRef: input.ref,
        path: designFilePath(input.dir, file),
        maxBytes,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (TOO_LARGE.test(code))
        throw new Error(what === null ? "document_too_large" : "board_too_large", { cause: error });
      if (NOT_TEXT.test(code)) {
        throw new BoardFormatError([
          what === null ? `${file} is not a UTF-8 text file` : `board ${what}: not a UTF-8 text file`,
        ]);
      }
      throw error;
    }
  };
  const manifestText = await at(MANIFEST_PATH, MANIFEST_READ_BYTES, null);
  if (manifestText === null) throw new BoardFormatError(["manifest.json is missing"]);
  const manifest = parseManifest(manifestText);
  const files: Record<string, string> = { [MANIFEST_PATH]: manifestText };
  for (const b of manifest.boards) {
    const text = await at(b.file, BOARD_MAX_BYTES + 1, b.id);
    if (text === null) throw new BoardFormatError([`board ${b.id}: file is missing`]);
    if (Buffer.byteLength(text, "utf8") > BOARD_MAX_BYTES) throw new Error("board_too_large");
    files[b.file] = text;
  }
  const brand = await at(BRAND_PATH, BRAND_MAX_BYTES, null);
  if (brand !== null) files[BRAND_PATH] = brand;
  return Object.fromEntries(Object.entries(files).map(([p, t]) => [p, redactTokenShapedValues(t)]));
}
