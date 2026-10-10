/**
 * Brokered secrets at request time: check the destination, place each value where its
 * owner said, and scrub values from the response. Pure — the privileged host
 * (host-functions.ts) does the I/O. SigV4 signing is in secret-broker-sigv4.ts.
 */
import { parseSigV4Value, type SecretBrokerConfig } from "../core/secret-broker-config.js";

export interface BrokeredSecret {
  name: string;
  value: string;
  broker: SecretBrokerConfig;
}
export interface BrokerRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

const REDACTED = "[REDACTED]";

function deny(reason: string): never {
  throw new Error(`secret_broker_destination_denied: ${reason}`);
}
function conflict(reason: string): never {
  throw new Error(`secret_broker_conflict: ${reason}`);
}

export function checkBrokerDestination(url: string, secrets: readonly BrokeredSecret[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    deny("invalid URL");
  }
  if (parsed.protocol !== "https:") deny("brokered secrets are only sent over https");
  if (parsed.port !== "") deny("brokered secrets are only sent to the default https port");
  const host = parsed.hostname.toLowerCase();
  for (const s of secrets) {
    if (!s.broker.hosts.includes(host)) deny(`"${s.name}" may not be sent to ${host}`);
    const prefixes = s.broker.pathPrefixes ?? [];
    if (prefixes.length && !prefixes.some((p) => parsed.pathname.startsWith(p))) {
      deny(`"${s.name}" may not be sent to path ${parsed.pathname}`);
    }
  }
}

function contentType(headers: Record<string, string>): string {
  return (headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
}

export function applyBrokerPlacements(request: BrokerRequest, secrets: readonly BrokeredSecret[]): BrokerRequest {
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const url = new URL(request.url);
  let body = request.body;
  const placed = new Set<string>();
  for (const s of secrets) {
    const p = s.broker.placement;
    if (p.kind === "header") {
      const key = p.name.toLowerCase();
      if (key in headers || placed.has(`h:${key}`)) conflict(`header "${p.name}" is set by the broker for "${s.name}"`);
      headers[key] = p.format.replace("{value}", s.value);
      placed.add(`h:${key}`);
    } else if (p.kind === "query") {
      if (url.searchParams.has(p.name) || placed.has(`q:${p.name}`))
        conflict(`query parameter "${p.name}" is set by the broker for "${s.name}"`);
      url.searchParams.append(p.name, s.value);
      placed.add(`q:${p.name}`);
    } else if (p.kind === "body") {
      if (placed.has(`b:${p.field}`)) conflict(`body field "${p.field}" is set by the broker for "${s.name}"`);
      body = placeBodyField(headers, body, p.field, s);
      placed.add(`b:${p.field}`);
    }
  }
  return { ...request, url: url.href, headers, body };
}

function placeBodyField(
  headers: Record<string, string>,
  body: string | undefined,
  field: string,
  s: BrokeredSecret,
): string {
  const type = contentType(headers);
  if (body === undefined)
    throw new Error(`secret_broker_body_invalid: "${s.name}" is placed in the body, but the request has none`);
  if (type === "application/json" || type.endsWith("+json")) {
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch {
      throw new Error("secret_broker_body_invalid: the body is not valid JSON");
    }
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      throw new Error("secret_broker_body_invalid: a brokered JSON body must be an object");
    }
    if (Object.hasOwn(json, field)) conflict(`body field "${field}" is set by the broker for "${s.name}"`);
    return JSON.stringify({ ...(json as Record<string, unknown>), [field]: s.value });
  }
  if (type === "application/x-www-form-urlencoded") {
    const form = new URLSearchParams(body);
    if (form.has(field)) conflict(`body field "${field}" is set by the broker for "${s.name}"`);
    form.append(field, s.value);
    return form.toString();
  }
  throw new Error("secret_broker_body_invalid: body placement needs a JSON-object or form-encoded body");
}

export function brokerScrubValues(secrets: readonly BrokeredSecret[]): string[] {
  return secrets.flatMap((s) => {
    if (s.broker.placement.kind !== "aws-sigv4") return [s.value];
    const creds = parseSigV4Value(s.value);
    return [creds.secretAccessKey, ...(creds.sessionToken ? [creds.sessionToken] : [])];
  });
}

function encodedForms(value: string): string[] {
  const buf = Buffer.from(value, "utf8");
  return [
    ...new Set([
      value,
      buf.toString("base64"),
      buf.toString("base64").replace(/=+$/, ""),
      buf.toString("base64url"),
      encodeURIComponent(value),
    ]),
  ]
    .filter((form) => form.length >= 6)
    .sort((a, b) => b.length - a.length);
}

function scrubText(text: string, forms: readonly string[]): string {
  let out = text;
  for (const form of forms) out = out.split(form).join(REDACTED);
  return out;
}

export function scrubBrokeredResponse<T extends { headers: Record<string, string>; bodyBase64: string; url: string }>(
  response: T,
  values: readonly string[],
): T {
  const forms = values.flatMap(encodedForms);
  const body = Buffer.from(response.bodyBase64, "base64").toString("latin1");
  // latin1 is byte-preserving, so scrubbing never corrupts non-UTF-8 bodies; every encoded form is ASCII,
  // and a UTF-8 plaintext's bytes appear verbatim in latin1 as the latin1 decode of its UTF-8 bytes.
  const latinForms = forms.map((f) => Buffer.from(f, "utf8").toString("latin1"));
  return {
    ...response,
    url: scrubText(response.url, forms),
    headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, scrubText(v, forms)])),
    bodyBase64: Buffer.from(scrubText(body, latinForms), "latin1").toString("base64"),
  };
}
