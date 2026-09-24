import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_CODING_ARTIFACT_BYTES, parseCodingTaskInputJson, type CodingAgentOutput } from "../coding/protocol.js";

/**
 * Reads a regular file of at most `maxBytes`, refusing symlinks and anything
 * that is not a regular file.
 *
 * Every check runs against the open handle, never against the path before
 * opening it: an lstat followed by a read of the same path leaves a window in
 * which the file can be swapped for a symlink or a larger file. O_NOFOLLOW
 * refuses a symlink at open time, O_NONBLOCK keeps a FIFO from hanging the
 * open, and fstat on the descriptor checks what was actually opened. The lstat
 * afterwards covers platforms without O_NOFOLLOW: it must be the same inode.
 */
export async function readBoundedRegularFile(path: string, maxBytes: number, errorCode: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    // ELOOP: the path is a symlink.
    if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new Error(errorCode, { cause: error });
    throw error;
  }
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > maxBytes) throw new Error(errorCode);
    const link = await lstat(path);
    if (link.isSymbolicLink() || link.ino !== metadata.ino || link.dev !== metadata.dev) throw new Error(errorCode);
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
