import { loadAgentSecretValues } from "../secret-guard.js";
import { redactExactSecretValues } from "../secret-spans.js";

type Cipher = Parameters<typeof loadAgentSecretValues>[1];
type Db = Parameters<typeof loadAgentSecretValues>[0];

/** The document agent's secret values (empty without an agent), loaded once per write. */
export async function documentSecretValues(db: Db, cipher: Cipher, agentId: string | null): Promise<string[]> {
  if (!agentId) return [];
  return (await loadAgentSecretValues(db, cipher, agentId)).flatMap((e) => e.values);
}

/** Removes the document agent's secret values from text before it is stored. No agent: unchanged. */
export async function redactForDocumentAgent(
  db: Db,
  cipher: Cipher,
  agentId: string | null,
  text: string,
): Promise<string> {
  if (!agentId) return text;
  return redactExactSecretValues(text, await documentSecretValues(db, cipher, agentId));
}
