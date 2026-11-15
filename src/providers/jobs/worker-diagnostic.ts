/**
 * The one fixed diagnostic a failed coding worker may report about itself (`{"error": code}` plus an
 * optional `issues` list), shared by every launcher: Docker and Kubernetes read it from the worker's
 * log tail, the Substrate launcher from the exit report its agent bridge posts through the coding
 * proxy. Worker output is untrusted, so only values that pass these patterns are ever kept.
 */
import { MAX_CODING_OUTPUT_ISSUES, SAFE_CODING_OUTPUT_ISSUE } from "../../coding/protocol.js";

export const SAFE_WORKER_DIAGNOSTIC = /^(?:worker_[a-z_]+|coding_[a-z_]+|wardby_[a-z_]+)$/;

export interface WorkerDiagnostic {
  diagnostic: string;
  diagnosticIssues?: string[];
}

/**
 * The diagnostic for an `error` code and an optional `issues` list; undefined unless the code passes
 * SAFE_WORKER_DIAGNOSTIC. A list with any entry that does not pass SAFE_CODING_OUTPUT_ISSUE (or too
 * many entries) is dropped whole rather than filtered, so a malformed worker cannot smuggle a partial
 * value through.
 */
export function workerDiagnosticOf(error: unknown, issues: unknown): WorkerDiagnostic | undefined {
  if (typeof error !== "string" || !SAFE_WORKER_DIAGNOSTIC.test(error)) return undefined;
  const safeIssues =
    Array.isArray(issues) &&
    issues.length > 0 &&
    issues.length <= MAX_CODING_OUTPUT_ISSUES &&
    issues.every((issue) => typeof issue === "string" && SAFE_CODING_OUTPUT_ISSUE.test(issue))
      ? (issues as string[])
      : undefined;
  return { diagnostic: error, ...(safeIssues ? { diagnosticIssues: [...safeIssues] } : {}) };
}

/** Recognizes only the fixed `{"error": code}` line (see workerDiagnosticOf); anything else is undefined. */
export function parseWorkerDiagnosticLine(line: string): WorkerDiagnostic | undefined {
  let value: { error?: unknown; issues?: unknown } | null;
  try {
    value = JSON.parse(line) as { error?: unknown; issues?: unknown } | null;
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object") return undefined;
  return workerDiagnosticOf(value.error, value.issues);
}
