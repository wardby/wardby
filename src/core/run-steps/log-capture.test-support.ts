import { vi } from "vitest";

/**
 * Captures what a module writes through its real default logger, at trace level, and through
 * console.*, so a leak written below the info level or past an injected `log` spy is still seen.
 * `load` re-imports the modules under test with LOG_LEVEL=trace (a child logger fixes its level
 * when it is created), then hooks the logger's line filter. Call `restore` in a finally block.
 */
export function traceLogCapture() {
  const lines: string[] = [];
  const consoleCalls: unknown[][] = [];
  let setFilter: ((filter: (line: string) => string) => void) | undefined;
  return {
    async load<T>(importer: () => Promise<T>): Promise<T> {
      vi.resetModules();
      vi.stubEnv("LOG_LEVEL", "trace");
      const loaded = await importer();
      setFilter = (await import("../logger.js")).setLogLineFilter;
      setFilter((line) => {
        lines.push(line);
        return "";
      });
      for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const) {
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void consoleCalls.push(args));
      }
      return loaded;
    },
    /** Everything logged or printed so far, serialized. */
    text: () => JSON.stringify([lines, consoleCalls]),
    /** The number of log lines written (a guard that the capture is live). */
    lineCount: () => lines.length,
    restore() {
      setFilter?.((line) => line);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      vi.resetModules();
    },
  };
}
