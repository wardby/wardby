/**
 * A static, best-effort check: a tool granted a brokered secret that still reads secrets with
 * secrets.get() will fail at run time. Warns; never blocks (the scan can't see dynamic code).
 */
export function toolCallsSecretsGet(code: string): boolean {
  return /\bsecrets\s*\.\s*get\s*\(/.test(code);
}

export function brokerCompatibilityWarnings(
  tools: readonly { name: string; code: string; allowedSecrets: readonly string[] }[],
  brokeredNames: ReadonlySet<string>,
): string[] {
  const warnings: string[] = [];
  for (const tool of tools) {
    const brokered = tool.allowedSecrets.filter((s) => brokeredNames.has(s));
    if (!brokered.length || !toolCallsSecretsGet(tool.code)) continue;
    const list = brokered.map((s) => `"${s}"`).join(", ");
    const example = JSON.stringify(brokered);
    warnings.push(
      `Tool "${tool.name}" reads secrets with secrets.get(), but ${list} ${brokered.length > 1 ? "are" : "is"} brokered: that call will fail with secret_brokered. Update the tool to send it with fetch(url, { secrets: ${example} }).`,
    );
  }
  return warnings;
}

/** An attachment's `allowedSecrets` JSON column as names (anything else is ignored). */
export function allowedSecretNames(json: unknown): string[] {
  return Array.isArray(json) ? json.filter((s): s is string => typeof s === "string") : [];
}
