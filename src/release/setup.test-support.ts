/**
 * Set-up for the release regression suite (vitest.release.config.ts): every line the shared
 * logger writes is captured for the secret sweep (secret-sweep.test-support.ts) instead of being
 * written to stderr. The config sets LOG_LEVEL=trace, so lines at every level are captured.
 * WARDBY_RELEASE_LOG=1 also writes them out, for debugging a failing case.
 */
import { setLogLineFilter } from "../core/logger.js";
import { capturedLogLines } from "./log-capture.test-support.js";

const passThrough = process.env.WARDBY_RELEASE_LOG === "1";

setLogLineFilter((line) => {
  capturedLogLines.push(line);
  return passThrough ? line : "";
});
