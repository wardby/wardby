import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
type Db = Parameters<typeof loadAgentSecretValues>[0];

/** Removes the document agent's secret values from text before it is stored. No agent: unchanged. */
export async function redactForDocumentAgent(
  db: Db,
  cipher: Cipher,
  agentId: string | null,
  text: string,
): Promise<string> {
  if (!agentId) return text;
  const values = (await loadAgentSecretValues(db, cipher, agentId)).flatMap((e) => e.values);
  return redactExactSecretValues(text, values);
}
