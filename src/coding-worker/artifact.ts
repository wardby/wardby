import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_CODING_ARTIFACT_BYTES, parseCodingTaskInputJson, type CodingAgentOutput } from "../coding/protocol.js";

/**
 * Reads a regular file of at most `maxBytes`, refusing symlinks and anything
 * that is not a regular file.
 *
 * The checks run against the open handle, not the path. An lstat followed by a
 * readFile on the same path leaves a window in which the file can be swapped
 * for a symlink or a larger file; O_NOFOLLOW plus an fstat on the descriptor
 * closes it. The lstat is kept for platforms without O_NOFOLLOW.
 */
export async function readBoundedRegularFile(path: string, maxBytes: number, errorCode: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(errorCode);
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    // ELOOP: the path became a symlink after the lstat above.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorCode, { cause: error });
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maxBytes || metadata.ino !== before.ino || metadata.dev !== before.dev) {
      throw new Error(errorCode);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) throw new Error(errorCode);
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    await file.close();
  }
}

export async function readCodingInput(path: string) {
  return parseCodingTaskInputJson(
    await readBoundedRegularFile(path, MAX_CODING_ARTIFACT_BYTES, "coding_input_invalid_file"),
  );
}

export async function writeCodingOutputAtomic(path: string, output: CodingAgentOutput): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.result-${process.pid}-${Date.now()}.tmp`);
  const payload = `${JSON.stringify(output)}\n`;
  if (Buffer.byteLength(payload) > MAX_CODING_ARTIFACT_BYTES) throw new Error("coding_output_size_limit");
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(payload);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  const dir = await open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
