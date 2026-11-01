/**
 * Where one bound tool's request may go: the provider's API hosts, inside the path of
 * the repository this call is for, using the operation's own methods. Wardby picks
 * the repository, so a tool can't point a token at another one. Pure.
 */
export const MAX_HOST_TOOL_FETCHES = 3;

export interface HostToolRequestScope {
  apiHosts: readonly string[];
  pathPrefix: string;
  methods: readonly string[];
}

export class HostToolRequestDenied extends Error {
  constructor() {
    super("host_tool_request_denied");
    this.name = "HostToolRequestDenied";
  }
}

export function assertHostToolRequest(url: string, method: string, scope: HostToolRequestScope): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HostToolRequestDenied();
  }
  if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username || parsed.password) {
    throw new HostToolRequestDenied();
  }
  if (!scope.apiHosts.includes(parsed.hostname.toLowerCase())) throw new HostToolRequestDenied();
  if (!scope.methods.includes(method.toUpperCase())) throw new HostToolRequestDenied();
  const prefix = scope.pathPrefix.toLowerCase();
  if (!prefix.startsWith("/")) throw new HostToolRequestDenied();
  const path = normalizedPath(parsed.pathname);
  if (path !== prefix && !path.startsWith(`${prefix}/`)) throw new HostToolRequestDenied();
}

const MAX_DECODE_ROUNDS = 5;
const ALLOWED_HEADERS = ["accept", "content-type", "if-match", "if-none-match"];

/**
 * The path as a server may finally read it: decoded until stable, `;params` dropped from
 * each segment. Anything that could move it outside a prefix is a denial.
 */
function normalizedPath(pathname: string): string {
  let current = pathname;
  for (let round = 0; ; round++) {
    if (round > MAX_DECODE_ROUNDS) throw new HostToolRequestDenied();
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      throw new HostToolRequestDenied();
    }
    if (next === current) break;
    // Decoding must not create a separator that wasn't there.
    if (next.split("/").length !== current.split("/").length) throw new HostToolRequestDenied();
    current = next;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(current)) throw new HostToolRequestDenied();
  const segments = current.split("/").map((segment) => segment.split(";")[0] ?? "");
  if (segments.some((segment) => segment === "." || segment === "..")) throw new HostToolRequestDenied();
  return current
    .split("/")
    .map((segment) => segment.split(";")[0])
    .join("/")
    .toLowerCase();
}

/** Request headers a bound tool may set: no override, routing or credential headers. */
export function assertHostToolHeaders(headers: unknown): void {
  if (headers === undefined) return;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) throw new HostToolRequestDenied();
  for (const name of Object.keys(headers)) {
    if (!ALLOWED_HEADERS.includes(name.toLowerCase())) throw new HostToolRequestDenied();
  }
}
