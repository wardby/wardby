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
  // new URL resolves "..", "%2e%2e" and "\": an encoded separator is what it leaves for a server to decode.
  const path = parsed.pathname.toLowerCase();
  if (/%2f|%5c/.test(path)) throw new HostToolRequestDenied();
  const prefix = scope.pathPrefix.toLowerCase();
  if (path !== prefix && !path.startsWith(`${prefix}/`)) throw new HostToolRequestDenied();
}
