/**
 * Every line the shared logger wrote in this test file's worker, in order (filled by
 * setup.test-support.ts through the logger's line filter). A sweep reads the lines written after
 * it started. A test that installs its own line filter (setLogLineFilter) stops the capture.
 */
export const capturedLogLines: string[] = [];
