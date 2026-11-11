/**
 * A run's request (what it was asked to do) as its readers may see it, for MCP get_run and the
 * viewer API alike. It can be text a caller or an issue wrote, so the agent's secret values and
 * token-shaped values are masked on every read. A secret that can't be read means the text can't
 * be checked, so it is withheld; the log carries the error name only.
 */
import { redactTokenShapedValues } from "../coding/protocol.js";
import { logger } from "./logger.js";
import { loadAgentSecretValues, maskNamedSecrets } from "./secret-guard.js";

const log = logger.child({ module: "run-request" });

export async function requestForReader(
  db: Parameters<typeof loadAgentSecretValues>[0],
  secrets: Parameters<typeof loadAgentSecretValues>[1],
  run: { id: string; agentId: string },
  request: string,
): Promise<{ request: string } | { requestUnavailable: true }> {
  try {
    const named = await loadAgentSecretValues(db, secrets, run.agentId);
    return { request: redactTokenShapedValues(maskNamedSecrets(request, named)) };
  } catch (err) {
    log.warn(
      { runId: run.id, errorName: err instanceof Error ? err.name : typeof err },
      "could not read the agent's secrets to check a run's request; withholding it",
    );
    return { requestUnavailable: true };
  }
}
