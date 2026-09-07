import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_CODING_ARTIFACT_BYTES, parseCodingTaskInputJson, type CodingAgentOutput } from "../coding/protocol.js";

export async function readCodingInput(path: string) {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_CODING_ARTIFACT_BYTES) {
    throw new Error("coding_input_invalid_file");
  }
  return parseCodingTaskInputJson(await readFile(path, "utf8"));
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
