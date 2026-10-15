import type { PrismaClient } from "#prisma";
import { composeCodingTask } from "../coding/protocol.js";
import { assertCodingProvider } from "../coding/provider.js";
import { parseAllowedServiceNames, type ResolvedCodingService } from "../coding/services/catalog.js";
import { servicesInstructionNote } from "../coding/services/note.js";
import { knowledgeSection } from "../knowledge/note.js";
import type { Executor } from "../providers/executor/types.js";
import { readKnowledgeIndexAt, readServiceDeclarationAt, resolveDispatchServices } from "./dispatch.js";

export interface ResolveDeferredCodingInput {
  db: PrismaClient;
  /** The starting process's own executor: the one with the coding configuration. */
  executor: Executor;
  runId: string;
}

/**
 * Coding inputs of a run the native gateway dispatched (DeferredExecutor): resolved here, on the
 * process that starts it, with its own executor — the gateway holds no coding configuration.
 * Marker: a pending coding run whose CodingRun.workerImage is null. False: the run was refused.
 */
export async function resolveDeferredCodingRun({ db, executor, runId }: ResolveDeferredCodingInput): Promise<boolean> {
  const run = await db.run.findUnique({
    where: { id: runId },
    include: { codingRun: true, agent: { include: { codingProfile: true } } },
  });
  const coding = run?.codingRun;
  // A native run, or a coding run dispatch already resolved: nothing to do.
  if (!run || !coding || coding.workerImage !== null) return true;
  const profile = run.agent.codingProfile;
  if (!profile) throw new Error(`coding_profile_missing: coding agent "${run.agentId}" has no coding profile.`);
  assertCodingProvider(coding.provider);
  // The provider is the run's own (fixed at dispatch); the toolchain and image ref are the profile's,
  // read as they are when the run starts.
  const selector = {
    provider: coding.provider,
    toolchain: profile.toolchain,
    toolchainVersion: profile.toolchainVersion,
    workerImageRef: profile.workerImageRef,
  };
  // Services before images, in dispatch's order: a run with both a refused declaration and a bad
  // image ends refused. As at dispatch, only an agent allowed some service reads the declaration,
  // and any refusal dispatch would have raised refuses the run here instead.
  let services: ResolvedCodingService[] = [];
  if (parseAllowedServiceNames(profile.services).length > 0) {
    const outcome = await readServiceDeclarationAt(executor, coding.repository, coding.baseRef);
    const resolved = await resolveDispatchServices(
      db,
      outcome,
      profile.services,
      executor,
      coding.provider,
      coding.task,
      run.agent.systemPrompt,
    );
    if ("refusal" in resolved) {
      await db.run.updateMany({
        where: { id: runId, status: "pending" },
        data: { status: "refused", error: resolved.refusal, finishedAt: new Date() },
      });
      return false;
    }
    services = resolved.services;
  }
  if (!executor.resolveCodingWorkerImage) {
    throw new Error("coding_execution_not_configured: this process cannot start coding runs.");
  }
  const workerImage = executor.resolveCodingWorkerImage(selector);
  const toolImage = executor.resolveCodingToolImage?.(selector) ?? null;
  const knowledge = await readKnowledgeIndexAt(executor, coding.repository, coding.baseRef);
  const task = composeCodingTask(
    run.agent.systemPrompt,
    coding.task,
    servicesInstructionNote(services),
    knowledge ? knowledgeSection(knowledge) : undefined,
  );
  // Conditional on the marker: of two racing starts, only one writes (both composed the same inputs).
  await db.codingRun.updateMany({
    where: { runId, workerImage: null },
    data: { workerImage, toolImage, services, task },
  });
  return true;
}
