/**
 * Repository-relative file paths the control plane accepts (a document's linked file, a file the GitHub
 * provider reads). Kept out of protocol.ts: that file is built into the coding-worker driver image, and
 * nothing in the worker needs this check.
 */
const SAFE_FILE_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** A repository-relative file path of plain segments ([A-Za-z0-9._-]), none of them `.` or `..`. */
export function isSafeFilePath(path: string): boolean {
  return SAFE_FILE_PATH.test(path) && !path.split("/").some((part) => part === "." || part === "..");
}
