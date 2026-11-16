// Actor and template steps both Substrate launchers (coding runs and the native sandbox) share.
// Every failure is reported with fixed fields only: the run, which call, and the error's fixed
// code. A request or a message is never read, since Substrate's errors may echo request content.
import type { Logger } from "../../core/logger.js";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateTemplateMissingError,
  SubstrateUnavailableError,
  type ActorTemplateSpec,
  type SubstrateApi,
  type TemplateInfo,
} from "./api.js";

/** The Substrate calls a launch makes, by SubstrateApi method name. */
export type SubstrateCall =
  | "ensureActorTemplate"
  | "getActorTemplate"
  | "deleteActorTemplate"
  | "createActor"
  | "putEgressPolicy"
  | "resumeActor"
  | "suspendActor"
  | "deleteEgressPolicy";

/** Fixed fields only: the run, which call failed, and the error's fixed code. Never a request or message. */
export interface SubstrateCallFailure {
  runId: string;
  substrateCall: SubstrateCall;
  errorCode: string;
}

/**
 * Runs one named call; a failure is reported (fixed fields) and rethrown. An error `recoverable`
 * names is rethrown without a report: the caller recovers from it, and reports only if that fails.
 */
export type NamedCall = <T>(
  name: SubstrateCall,
  fn: () => Promise<T>,
  recoverable?: (error: unknown) => boolean,
) => Promise<T>;

/** The fixed code of a failed Substrate call; any other error is "unexpected" (its message is never read). */
export function substrateErrorCode(error: unknown): string {
  if (
    error instanceof SubstrateAlreadyExistsError ||
    error instanceof SubstrateExhaustedError ||
    error instanceof SubstrateNotFoundError ||
    error instanceof SubstrateTemplateMissingError ||
    error instanceof SubstrateUnavailableError
  ) {
    return error.code;
  }
  return "unexpected";
}

/** createActor's answer when the template is gone: FailedPrecondition from Substrate, or NotFound. */
export function isTemplateGone(error: unknown): boolean {
  return error instanceof SubstrateTemplateMissingError || error instanceof SubstrateNotFoundError;
}

/** Reports through `sink`, or `log.warn({ ...failure }, "substrate_call_failed")`; never throws. */
export function reportCallFailure(
  failure: SubstrateCallFailure,
  sink: ((failure: SubstrateCallFailure) => void) | undefined,
  log: Pick<Logger, "warn">,
): void {
  try {
    if (sink) sink(failure);
    else log.warn({ ...failure }, "substrate_call_failed");
  } catch {
    // Reporting never changes the launch's outcome.
  }
}

export function namedCall(runId: string, report: (failure: SubstrateCallFailure) => void): NamedCall {
  return async <T>(
    name: SubstrateCall,
    fn: () => Promise<T>,
    recoverable?: (error: unknown) => boolean,
  ): Promise<T> => {
    try {
      return await fn();
    } catch (error) {
      if (!recoverable?.(error)) report({ runId, substrateCall: name, errorCode: substrateErrorCode(error) });
      throw error;
    }
  };
}

/**
 * Creates the template unless it exists; one whose golden snapshot failed for good is deleted and
 * created again, once per call. `onGoldenFailed` runs before the delete and may throw to refuse it
 * (the coding launcher's template store); absent, it always recreates. Returns the status read
 * (the one that showed the failure, after a recreate), for a caller that records readiness.
 */
export async function ensureTemplate(
  api: SubstrateApi,
  template: ActorTemplateSpec,
  call: NamedCall,
  onGoldenFailed?: () => Promise<void>,
): Promise<TemplateInfo | undefined> {
  const { name, atespace } = template;
  await call("ensureActorTemplate", () => api.ensureActorTemplate(template));
  const info = await call("getActorTemplate", () => api.getActorTemplate(atespace, name));
  if (!info?.goldenSnapshotFailed) return info;
  await onGoldenFailed?.();
  await call("deleteActorTemplate", () => api.deleteActorTemplate(atespace, name));
  await call("ensureActorTemplate", () => api.ensureActorTemplate(template));
  return info;
}

/**
 * Creates the actor from `template`, never taking an existing one over: AlreadyExists, its policy and
 * the actor are deleted (any failure there rethrows the AlreadyExists) and it is created again.
 * `onTemplateMissing`: the template is gone (FailedPrecondition or NotFound), called once, then the
 * actor is created once more; that answer is not reported unless the second attempt fails.
 */
export async function createFreshActor(
  api: SubstrateApi,
  atespace: string,
  name: string,
  template: string,
  call: NamedCall,
  onTemplateMissing?: () => Promise<void>,
): Promise<void> {
  const create = async (): Promise<void> => {
    try {
      await api.createActor(atespace, name, template);
    } catch (error) {
      if (!(error instanceof SubstrateAlreadyExistsError)) throw error;
      try {
        await deleteActorWithPolicy(api, atespace, name);
      } catch {
        throw error;
      }
      await api.createActor(atespace, name, template);
    }
  };
  try {
    await call("createActor", create, onTemplateMissing ? isTemplateGone : undefined);
  } catch (error) {
    if (!onTemplateMissing || !isTemplateGone(error)) throw error;
    await onTemplateMissing();
    await call("createActor", create);
  }
}

/** Deletes the policy, then the actor; each missing one is success. */
export async function deleteActorWithPolicy(api: SubstrateApi, atespace: string, name: string): Promise<void> {
  await api.deleteEgressPolicy(atespace, name);
  await api.deleteActor(atespace, name);
}
