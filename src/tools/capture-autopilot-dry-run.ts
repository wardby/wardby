/**
 * Terminal wiring for the platform dry-run capture. Environment in, committed
 * fixture out; every decision lives in capture-fixture.ts, which is unit-tested.
 *
 *   npm run capture:autopilot     # writes the fixture and prints the mutation list
 *
 * A development tool, run deliberately and reviewed in a diff. Nothing at
 * runtime calls it: the admission chain that produces these mutations is the
 * same one an attacker with cluster access would subvert, so it can never be
 * allowed to bless itself at launch time.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import "../env.js";
import { loadContainerExecutorConfig, loadKubernetesJobConfig } from "../config/providers.js";
import { ClientNodeKubernetesApi } from "../providers/jobs/kubernetes-client.js";
import { captureFixture } from "./capture-fixture.js";

const FIXTURE = fileURLToPath(new URL("../providers/jobs/fixtures/gke-autopilot-dry-run.json", import.meta.url));

/**
 * An API rejection carries its reason in the response body's `Status` object
 * ("Pod ... is forbidden: ...", the failing field, the admission webhook that
 * refused) — never in the exception's own message. Printing only the message
 * turns every real failure into "Bad Request", which is exactly the position an
 * operator running a one-shot capture against a fresh cluster cannot debug from.
 */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const lines = [error.message];
  const body: unknown = (error as { body?: unknown }).body;
  if (body !== undefined) lines.push(typeof body === "string" ? body : JSON.stringify(body, null, 2));
  const cause: unknown = error.cause;
  if (cause !== undefined) {
    lines.push(`cause: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const config = loadKubernetesJobConfig();
  const container = loadContainerExecutorConfig();
  if (!container.workerImage) throw new Error("CODING_WORKER_IMAGE is required.");
  const api = new ClientNodeKubernetesApi({ context: config.context });
  const fixture = await captureFixture(api, {
    namespace: config.namespace,
    proxyService: config.proxyService,
    platform: config.platform,
    runtimeClassName: config.runtimeClassName,
    workerImage: container.workerImage,
  });
  writeFileSync(FIXTURE, `${JSON.stringify(fixture, null, 2)}\n`);
  console.log(JSON.stringify(fixture.mutations, null, 2));
  console.log(`wrote ${FIXTURE} (${fixture.mutations.length} mutation(s)) — review the diff before committing it`);
}

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
