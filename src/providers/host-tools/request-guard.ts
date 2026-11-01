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
  // The repository is matched literally on the raw path; decoding is only for the segment rules.
  const raw = parsed.pathname.toLowerCase();
  if (raw !== prefix && !raw.startsWith(`${prefix}/`)) throw new HostToolRequestDenied();
  assertSafeSegments(parsed.pathname);
}

const MAX_DECODE_ROUNDS = 8;
const ALLOWED_HEADERS = ["accept", "content-type", "if-match", "if-none-match"];
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decodes every run of valid %XX escapes as UTF-8 bytes; a stray % stays literal. */
function decodeOnce(text: string): string {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    const bytes = Uint8Array.from(run.match(/%([0-9a-f]{2})/gi) ?? [], (hex) => parseInt(hex.slice(1), 16));
    return utf8.decode(bytes);
  });
}

/**
 * The path as a server may finally read it: decoded and NFKC-normalized together to
 * stable (a fullwidth percent sign becomes a real one), then judged per segment. Servers and proxies disagree on what a segment "is" (encoded or
 * Unicode lookalike separators, stripped whitespace or format characters, trailing
 * delimiters), so a segment that is only dots once those are removed is refused, and so
 * is anything that changes the segment count. Ordinary names with odd characters pass.
 */
function assertSafeSegments(pathname: string): void {
  let current = pathname;
  for (let round = 0; ; round++) {
    if (round > MAX_DECODE_ROUNDS) throw new HostToolRequestDenied();
    let next: string;
    try {
      next = decodeOnce(current).normalize("NFKC");
    } catch {
      throw new HostToolRequestDenied();
    }
    if (next === current) break;
    current = next;
  }
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000\u2215\u2044]/.test(current)) throw new HostToolRequestDenied();
  const segments = current.split("/");
  if (segments.length !== pathname.split("/").length) throw new HostToolRequestDenied();
  for (const segment of segments) {
    // % is stripped too: a stray % must not turn "..%" into a passing name.
    const bare = segment.replace(/[\p{Z}\p{C}%]/gu, "");
    if (/^\.+(?:[;?#,:].*)?$/.test(bare)) throw new HostToolRequestDenied();
  }
}

/** Request headers a bound tool may set: no override, routing or credential headers. */
export function assertHostToolHeaders(headers: unknown): void {
  if (headers === undefined) return;
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) throw new HostToolRequestDenied();
  for (const name of Object.keys(headers)) {
    if (!ALLOWED_HEADERS.includes(name.toLowerCase())) throw new HostToolRequestDenied();
  }
}
