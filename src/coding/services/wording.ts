/**
 * What a host (a status comment, a sub-agent's reply) is told when a coding
 * run's services stopped it, and the error strings those sentences travel in.
 * Public repositories read these, so they carry only fixed text, validated
 * service names and versions, and the declaration's line numbers.
 */
import type { UnstartableService, UnstartableServiceReason } from "../../providers/jobs/types.js";
import { CODING_SERVICE_NAME } from "../protocol.js";

export const SERVICE_REFUSAL_CODES = [
  "service_declaration_invalid",
  "service_declaration_unavailable",
  "service_unknown",
  "service_not_allowed",
  "service_launcher_unsupported",
] as const;
export type ServiceRefusalCode = (typeof SERVICE_REFUSAL_CODES)[number];

/** Run.error for a coding run refused at dispatch over its services: `<code>: <host sentence>`. */
export function serviceRefusal(code: ServiceRefusalCode, sentence: string): string {
  return `${code}: ${sentence}`;
}

/** The host sentence inside a service refusal's Run.error, or null for any other error. */
export function serviceRefusalSentence(error: string | null | undefined): string | null {
  if (!error) return null;
  for (const code of SERVICE_REFUSAL_CODES) {
    const prefix = `${code}: `;
    if (error.startsWith(prefix)) return error.slice(prefix.length);
  }
  return null;
}

export function invalidDeclarationSentence(reason: string): string {
  return `\`.wardby/services.yaml\` is invalid: ${reason}.`;
}

export function unknownServiceSentence(name: string, version: string): string {
  return `This repository asks for \`${name} ${version}\`, which wardby's service catalog doesn't have.`;
}

export function notAllowedServiceSentence(name: string): string {
  return `This repository asks for \`${name}\`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.`;
}

/**
 * A catalog entry declared under a key its kind doesn't belong to: a toolchain outside `toolchain:`,
 * a setup job outside `setup:`, or a sidecar outside `services:` (`declaredUnder` names where it was).
 */
export function misplacedServiceSentence(
  name: string,
  kind: "sidecar" | "toolchain" | "setup",
  declaredUnder: "services" | "toolchain" | "setup" = "toolchain",
): string {
  if (kind === "toolchain")
    return invalidDeclarationSentence(`\`${name}\` is a toolchain; declare it under \`toolchain:\``);
  if (kind === "setup") return invalidDeclarationSentence(`\`${name}\` is a setup job; declare it under \`setup:\``);
  const not = declaredUnder === "setup" ? "a setup job" : "a toolchain";
  return invalidDeclarationSentence(`\`${name}\` is a service, not ${not}; declare it under \`services:\``);
}

/** A setup job whose catalog entry waits for a service the run doesn't declare under `services:`. */
export function setupWaitForSentence(name: string, service: string): string {
  return invalidDeclarationSentence(`\`${name}\` needs \`${service}\`; declare it under \`services:\``);
}

/**
 * A `service_declaration_invalid` refusal for the resolver: the declared
 * services parsed, but the instruction note they add to the coding task would
 * push it over MAX_CODING_TASK_BYTES.
 */
export const SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE = invalidDeclarationSentence(
  "the declared services' instructions exceed the task size limit",
);

export const DECLARATION_UNAVAILABLE_SENTENCE =
  "wardby couldn't read `.wardby/services.yaml` from the base branch, so the run was not started. Try again.";

export const LAUNCHER_UNSUPPORTED_SENTENCE =
  "This repository asks for services, which this wardby deployment can't start: services need the Kubernetes, Docker or Substrate job launcher.";

const UNSTARTABLE_REASON_CLAUSES: Record<UnstartableServiceReason, string> = {
  start_command_missing: "its service catalog entry has no start command",
  data_path_reserved: "its service catalog entry's data path overlaps a directory the job launcher reserves",
  setup_too_large: "its service catalog entry's environment and commands are too large for the job launcher",
  toolchain_unsupported: "toolchains are not supported on this launcher yet",
  setup_unsupported: "setup jobs are not supported on this launcher yet",
};

/** A per-service service_launcher_unsupported sentence (the launcher can run services, but not this one). */
export function unstartableServiceSentence(service: UnstartableService): string {
  // Only the validated catalog name and a fixed clause: nothing else of the entry reaches a host.
  if (!CODING_SERVICE_NAME.test(service.name)) return LAUNCHER_UNSUPPORTED_SENTENCE;
  const what =
    service.reason === "toolchain_unsupported"
      ? "the toolchain "
      : service.reason === "setup_unsupported"
        ? "the setup job "
        : "";
  return `This repository asks for ${what}\`${service.name}\`, which this wardby deployment can't start: ${UNSTARTABLE_REASON_CLAUSES[service.reason]}.`;
}

/** service_launcher_unsupported for a Codex agent whose repository declares a toolchain (until Codex forwarding lands). */
export function codexToolchainSentence(name: string): string {
  const named = CODING_SERVICE_NAME.test(name) ? ` \`${name}\`` : "";
  return `This repository asks for the toolchain${named}, which this agent can't use: toolchains are not supported for Codex agents yet.`;
}

/** The launcher's error when a service's sidecar never became ready: `coding_service_unready:<name>`. */
export const SERVICE_UNREADY_ERROR = "coding_service_unready";
/** CodingRun.failureCategory for that failure. */
export const SERVICE_UNREADY_CATEGORY = "service_unready";

export function serviceUnreadyError(name: string): Error {
  return new Error(`${SERVICE_UNREADY_ERROR}:${name}`);
}

/** The service a `coding_service_unready:<name>` error names, or null. */
export function serviceUnreadyName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const prefix = `${SERVICE_UNREADY_ERROR}:`;
  if (!message.startsWith(prefix)) return null;
  const name = message.slice(prefix.length);
  return CODING_SERVICE_NAME.test(name) ? name : null;
}

/** A setup job (#589) that exited non-zero: `coding_setup_failed:<name>` (job_ prefixed on the run). */
export const SETUP_FAILED_ERROR = "coding_setup_failed";
/** CodingRun.failureCategory for that failure. */
export const SETUP_FAILED_CATEGORY = "service_setup";

/** The setup job a `[job_]coding_setup_failed:<name>` error names, or null. */
export function setupFailedName(error: unknown): string | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  const match = /^(?:job_)?coding_setup_failed:(.+)$/.exec(message);
  return match && CODING_SERVICE_NAME.test(match[1]) ? match[1] : null;
}

export function setupFailedSentence(name: string | null): string {
  return name
    ? `The \`${name}\` setup job failed, so the run didn't start.`
    : "A setup job the run needs failed, so the run didn't start.";
}

export function serviceUnreadySentence(names: readonly string[]): string {
  if (names.length === 1) return `The \`${names[0]}\` service didn't become ready, so the run couldn't start.`;
  if (names.length > 1) {
    return `One of the run's services (${names.map((name) => `\`${name}\``).join(", ")}) didn't become ready, so the run couldn't start.`;
  }
  return "A service the run needs didn't become ready, so the run couldn't start.";
}
