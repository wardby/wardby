/**
 * The brokered branch of the privileged `__bridge_fetch`: resolves the named brokered secrets,
 * places them into the request, and scrubs them from the response. Gateway-side only —
 * host-functions.ts loads this with a dynamic import so the native worker image, which has no
 * zod/@smithy packages and none of this code, never loads it (see worker-imports.test.ts).
 */
import type { SecretsAccessor } from "../core/secrets.js";
import { assertBrokerableValue } from "../core/secret-broker-config.js";
import { boundedString } from "./bounded-json.js";
import { BRIDGE_INPUT_BYTES } from "./limits.js";
import type { safeFetch } from "./safe-fetch.js";
import {
  applyBrokerPlacements,
  brokerScrubValues,
  consoleRedactionValues,
  checkBrokerDestination,
  scrubBrokeredResponse,
  type BrokeredSecret,
} from "./secret-broker.js";
import { signSigV4 } from "./secret-broker-sigv4.js";

/** Most brokered secrets one fetch may name. */
const MAX_BROKERED_SECRETS_PER_REQUEST = 8;

/** Longest WWW-Authenticate value read for an RFC 6750 error; a longer one is not attributable. */
const MAX_WWW_AUTHENTICATE_CHARS = 2048;

/**
 * Whether a 401 says the bearer token itself is bad: a WWW-Authenticate challenge with the Bearer
 * scheme (any case) whose `error` parameter is exactly `invalid_token` (RFC 6750 §3.1). Strict and
 * bounded: a missing, overlong or unparsable header, another scheme, or any other error is not.
 */
export function isInvalidTokenChallenge(headers: unknown): boolean {
  if (headers === null || typeof headers !== "object") return false;
  const values = Object.entries(headers as Record<string, unknown>)
    .filter(([key]) => key.toLowerCase() === "www-authenticate")
    .map(([, v]) => v);
  if (values.length !== 1) return false;
  const value = values[0];
  if (typeof value !== "string" || value.length > MAX_WWW_AUTHENTICATE_CHARS) return false;
  // One challenge only: the scheme, then comma-separated auth-params (token=token or token="quoted").
  const match = /^\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)(?:\s+(.*))?$/s.exec(value);
  if (!match || match[1].toLowerCase() !== "bearer") return false;
  const params = match[2] ?? "";
  const param = /\s*([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([A-Za-z0-9!#$%&'*+.^_`|~-]+))\s*(,|$)/y;
  let error: string | undefined;
  let at = 0;
  while (at < params.length) {
    param.lastIndex = at;
    const m = param.exec(params);
    if (!m) return false;
    const name = m[1].toLowerCase();
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3];
    if (name === "error") {
      if (error !== undefined) return false;
      error = raw;
    }
    at = param.lastIndex;
    if (m[4] === "") break;
  }
  return error === "invalid_token";
}

export interface BrokeredFetchInput {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
  secretNames: unknown;
  secrets: SecretsAccessor | undefined;
  fetchImpl: typeof safeFetch;
  policy: Parameters<typeof safeFetch>[2];
  /** Registers a value for redaction from console output, before any network call that might throw. */
  redactFromConsole: (value: string) => void;
}

export async function brokeredFetch(input: BrokeredFetchInput): Promise<unknown> {
  const { url, init, secretNames, secrets, fetchImpl, policy, redactFromConsole } = input;
  if (!Array.isArray(secretNames) || secretNames.length > MAX_BROKERED_SECRETS_PER_REQUEST) {
    throw new Error(
      `secret_not_brokered: secrets must be a list of at most ${MAX_BROKERED_SECRETS_PER_REQUEST} brokered secret names`,
    );
  }
  boundedString(url, BRIDGE_INPUT_BYTES);
  const brokered: BrokeredSecret[] = [];
  const oauthNames = new Set<string>();
  // Every value an OAuth secret lists (refresh token, client secret too) is scrubbed from responses.
  const extraScrub: string[] = [];
  for (const name of secretNames) {
    boundedString(name, 1024);
    // The fetch's stop signal reaches an OAuth refresh too, so a stopped call releases its row lock.
    const entry = secrets?.resolve ? await secrets.resolve(name, { signal: policy?.signal }) : undefined;
    if (!entry?.broker)
      throw new Error(`secret_not_brokered: "${name}" is not a brokered secret attached to this tool`);
    assertBrokerableValue(entry.broker, entry.value);
    const secret: BrokeredSecret = { name, value: entry.value, broker: entry.broker };
    for (const value of consoleRedactionValues(entry)) redactFromConsole(value);
    if (entry.oauth) {
      oauthNames.add(name);
      extraScrub.push(...entry.oauth.redact);
    }
    brokered.push(secret);
  }
  const sigv4 = brokered.filter((s) => s.broker.placement.kind === "aws-sigv4");
  if (sigv4.length > 1) throw new Error("secret_broker_conflict: at most one AWS SigV4 secret per request");
  checkBrokerDestination(url, brokered);
  const send = async (list: readonly BrokeredSecret[]) => {
    let request = applyBrokerPlacements(
      { url, method: init.method ?? "GET", headers: init.headers ?? {}, body: init.body },
      list,
    );
    const signers = list.filter((s) => s.broker.placement.kind === "aws-sigv4");
    if (signers.length) request = await signSigV4(request, signers[0]);
    // safeFetch errors are fixed fetch_* codes that never echo the (possibly secret-bearing) URL.
    // Redirects come back unfollowed: a placed credential must never ride a redirect to another host.
    return fetchImpl(
      request.url,
      { method: request.method, headers: request.headers, body: request.body },
      { ...policy, followRedirects: false },
    );
  };
  const response = await send(brokered);
  if ((response as { status?: unknown }).status !== 401 || oauthNames.size === 0 || !secrets?.refresh) {
    return scrubBrokeredResponse(response, [...brokerScrubValues(brokered), ...extraScrub]);
  }
  // The 401 is one secret's own only when the request carried no other OAuth secret and the resource
  // named the token invalid. Only then may a secret with no refresh token be marked `rejected`: any
  // other 401 (a second secret's, or one tool code provoked on another path) changes no secret's state.
  const attributable = oauthNames.size === 1 && isInvalidTokenChallenge((response as { headers?: unknown }).headers);
  // One forced refresh and one retry. A refresh failure surfaces its fixed error, never the 401.
  const refreshed: BrokeredSecret[] = [];
  let changed = false;
  for (const secret of brokered) {
    if (!oauthNames.has(secret.name)) {
      refreshed.push(secret);
      continue;
    }
    const entry = await secrets.refresh(secret.name, secret.value, { signal: policy?.signal, attributable });
    if (!entry?.broker) {
      refreshed.push(secret);
      continue;
    }
    assertBrokerableValue(entry.broker, entry.value);
    // New token values join redaction before the retry is sent.
    for (const value of consoleRedactionValues(entry)) redactFromConsole(value);
    extraScrub.push(...(entry.oauth?.redact ?? []));
    if (entry.value !== secret.value) changed = true;
    refreshed.push({ name: secret.name, value: entry.value, broker: entry.broker });
  }
  // Nothing new to send (no refresh token, and the 401 was not attributable): the 401 comes back as is.
  if (!changed) return scrubBrokeredResponse(response, [...brokerScrubValues(brokered), ...extraScrub]);
  checkBrokerDestination(url, refreshed);
  const retried = await send(refreshed);
  return scrubBrokeredResponse(retried, [
    ...brokerScrubValues(brokered),
    ...brokerScrubValues(refreshed),
    ...extraScrub,
  ]);
}
