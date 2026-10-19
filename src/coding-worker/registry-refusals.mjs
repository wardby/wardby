// The run's recent package refusals, read from the registry proxy's
// `GET /registry/-/refusals` with the run's registry-only token, which the
// worker environment already carries in PIP_INDEX_URL (never the run
// capability). pip prints no 403 body and uv only "403 Forbidden", so a
// Python agent otherwise can't tell why an install found nothing. Used by
// `wardby-packages` (wardby-packages.mjs) and by the Claude Code tool runner
// after a failed command. Dependency-free on purpose, and never throws: a
// failed lookup only means no extra lines.

const TIMEOUT_MS = 3_000;
const MAX_FIELD_CHARS = 400;
const REGISTRY_PATH = "/registry/";
const PYPI_INDEX_PATH = "pypi/simple/";

/**
 * The registry base (`http://<proxy>/registry/`) and token from the worker's
 * PIP_INDEX_URL, or undefined when it is missing or not the proxy's PyPI
 * index. The token is sent only back to that same origin and path.
 */
export function registryAccess(env = process.env) {
  const raw = env.PIP_INDEX_URL;
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.password) return undefined;
  if (!url.pathname.endsWith(`${REGISTRY_PATH}${PYPI_INDEX_PATH}`)) return undefined;
  let token;
  try {
    token = decodeURIComponent(url.password);
  } catch {
    return undefined;
  }
  const base = `${url.protocol}//${url.host}${url.pathname.slice(0, -PYPI_INDEX_PATH.length)}`;
  return { base, token };
}

function field(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_CHARS;
}

/** The registry's recent refusals for the run (since `since`, else its default window); [] on any failure. */
export async function recentRefusals(access, since, fetchImpl = globalThis.fetch) {
  if (!access) return [];
  try {
    const query = since ? `?since=${encodeURIComponent(since.toISOString())}` : "";
    const response = await fetchImpl(`${access.base}-/refusals${query}`, {
      headers: { authorization: `Bearer ${access.token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const body = await response.json();
    if (!body || !Array.isArray(body.refusals)) return [];
    return body.refusals.filter(
      (row) =>
        row &&
        field(row.ecosystem) &&
        field(row.name) &&
        field(row.code) &&
        (row.version === undefined || field(row.version)) &&
        (row.hint === undefined || field(row.hint)),
    );
  } catch {
    return [];
  }
}

/** One line per refusal, with control characters removed: names come from the run's own requests. */
export function formatRefusals(refusals) {
  const clean = (text) => text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  return refusals.map(
    (row) =>
      `wardby: ${clean(row.ecosystem)} package ${clean(row.name)}${row.version ? ` ${clean(row.version)}` : ""} ` +
      `was refused by the package registry (${clean(row.code)})${row.hint ? `: ${clean(row.hint)}` : "."}`,
  );
}
