// Host APIs a migration bundle's tool may reference that reevo will NOT
// provide. sendEmail/getInboundEmail are intentionally absent here: they
// exist as throwing placeholders in SANDBOX_PRELUDE (they import fine and
// fail at runtime). npmLockUpdate is roadmap-excluded (spec §3.3), so a tool
// referencing it is rejected at import. Cross-checked against the live
// prelude so the list self-heals off anything the prelude later defines.
export const SPEC_UNSUPPORTED_HOST_APIS: readonly string[] = ["npmLockUpdate"];

export function supportedGlobalsFromPrelude(preludeSource: string): Set<string> {
  const names = new Set<string>();
  const re = /globalThis\.([A-Za-z_$][\w$]*)\s*=/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(preludeSource)) !== null) names.add(m[1]);
  return names;
}

export function scanToolCode(
  code: string,
  supported: ReadonlySet<string>,
): { ok: true } | { ok: false; rejectedApis: string[] } {
  const denied = SPEC_UNSUPPORTED_HOST_APIS.filter((api) => !supported.has(api));
  const hit = denied.filter((api) => new RegExp(`\\b${api}\\b`).test(code));
  return hit.length === 0 ? { ok: true } : { ok: false, rejectedApis: hit };
}
