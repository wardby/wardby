/**
 * The client of the proxy's `POST /registry/pypi/-/origins` route (providers/coding-proxy/registry/service.ts): asks the
 * proxy for the real upstream address of each file a lockfile names, and for the index address a `registry =` entry
 * carries. Used when a uv.lock written through the proxy is put back before collection. The token is sent as a bearer
 * header only; nothing here puts it, or an address the proxy answered with, into an error.
 */

export interface OriginFile {
  /** The project name as the proxy's file URL spells it. */
  name: string;
  filename: string;
}

export type OriginResult = { url: string } | { error: string };

export interface OriginAnswers {
  /** The registry value for packages resolved from the proxy's index, when the proxy answered at all. */
  index: string | null;
  /** Keyed by `originKey`. A file the proxy could not be asked about carries the error code that says why. */
  files: Map<string, OriginResult>;
}

/** Files and projects per request: under the route's own limits (MAX_ORIGIN_FILES, MAX_ORIGIN_PROJECTS). */
const CHUNK_FILES = 500;
const CHUNK_PROJECTS = 150;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024;
const MAX_URL_CHARS = 1024;

export const originKey = (file: OriginFile): string => `${file.name}\0${file.filename}`;

/** Codes this client reports for a request that got no usable answer (the proxy's own are `wardby_origin_*` and `wardby_*`). */
export const ORIGIN_UNREACHABLE = "wardby_origin_unreachable";
export const ORIGIN_BAD_ANSWER = "wardby_origin_bad_answer";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpsUrl(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length > max) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** The leading code of a proxy error body (`{ "error": "wardby_x: message" }`), or the fallback; never the message. */
function codeOf(text: string, fallback: string): string {
  try {
    const error = (JSON.parse(text) as { error?: unknown }).error;
    const code = typeof error === "string" ? error.split(":")[0] : "";
    return /^[a-z0-9_]{1,64}$/.test(code) ? code : fallback;
  } catch {
    return fallback;
  }
}

function chunksOf(files: readonly OriginFile[]): OriginFile[][] {
  const chunks: OriginFile[][] = [];
  let current: OriginFile[] = [];
  let projects = new Set<string>();
  for (const file of files) {
    if (
      current.length > 0 &&
      (current.length >= CHUNK_FILES || (!projects.has(file.name) && projects.size >= CHUNK_PROJECTS))
    ) {
      chunks.push(current);
      current = [];
      projects = new Set();
    }
    current.push(file);
    projects.add(file.name);
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current);
  return chunks;
}

/**
 * Asks the proxy about `files` (each pair once). Never throws: a request that fails marks its files with an error code
 * and leaves `index` null unless another request answered. `registryUrl` is the proxy's PyPI route, as everywhere in the
 * session. With no files, one request still fetches the index address.
 */
export async function resolvePypiOrigins(input: {
  registryUrl: string;
  token: string;
  files: readonly OriginFile[];
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<OriginAnswers> {
  const send = input.fetch ?? fetch;
  const endpoint = `${input.registryUrl.endsWith("/") ? input.registryUrl : `${input.registryUrl}/`}-/origins`;
  const answers: OriginAnswers = { index: null, files: new Map() };
  const unique = new Map(input.files.map((file) => [originKey(file), file] as const));
  for (const chunk of chunksOf([...unique.values()])) {
    const fail = (error: string) => {
      for (const file of chunk) answers.files.set(originKey(file), { error });
    };
    let text: string;
    let status: number;
    try {
      const response = await send(endpoint, {
        method: "POST",
        headers: { authorization: `Bearer ${input.token}`, "content-type": "application/json" },
        body: JSON.stringify({ files: chunk.map(({ name, filename }) => ({ name, filename })) }),
        signal: AbortSignal.timeout(input.timeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      text = await response.text();
    } catch {
      fail(ORIGIN_UNREACHABLE);
      continue;
    }
    if (status !== 200) {
      fail(codeOf(text, ORIGIN_UNREACHABLE));
      continue;
    }
    let body: unknown;
    try {
      if (text.length > MAX_RESPONSE_CHARS) throw new Error("too large");
      body = JSON.parse(text);
    } catch {
      fail(ORIGIN_BAD_ANSWER);
      continue;
    }
    const items = isRecord(body) ? body.files : undefined;
    if (!isRecord(body) || !isHttpsUrl(body.index, MAX_URL_CHARS) || !Array.isArray(items)) {
      fail(ORIGIN_BAD_ANSWER);
      continue;
    }
    answers.index ??= body.index.replace(/\/+$/, "");
    const wanted = new Set(chunk.map(originKey));
    for (const item of items as unknown[]) {
      if (!isRecord(item) || typeof item.name !== "string" || typeof item.filename !== "string") continue;
      const key = originKey({ name: item.name, filename: item.filename });
      if (!wanted.has(key)) continue;
      if (isHttpsUrl(item.url, MAX_URL_CHARS)) answers.files.set(key, { url: item.url });
      else {
        const code =
          typeof item.error === "string" && /^[a-z0-9_]{1,64}$/.test(item.error) ? item.error : ORIGIN_BAD_ANSWER;
        answers.files.set(key, { error: code });
      }
    }
    // A file the answer left out is unanswered, never silently fine.
    for (const file of chunk)
      if (!answers.files.has(originKey(file))) answers.files.set(originKey(file), { error: ORIGIN_BAD_ANSWER });
  }
  return answers;
}
