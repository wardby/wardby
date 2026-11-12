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
  // One forced refresh and one retry. A refresh failure surfaces its fixed error, never the 401.
  const refreshed: BrokeredSecret[] = [];
  for (const secret of brokered) {
    if (!oauthNames.has(secret.name)) {
      refreshed.push(secret);
      continue;
    }
    const entry = await secrets.refresh(secret.name, secret.value, { signal: policy?.signal });
    if (!entry?.broker) {
      refreshed.push(secret);
      continue;
    }
    assertBrokerableValue(entry.broker, entry.value);
    // New token values join redaction before the retry is sent.
    for (const value of consoleRedactionValues(entry)) redactFromConsole(value);
    extraScrub.push(...(entry.oauth?.redact ?? []));
    refreshed.push({ name: secret.name, value: entry.value, broker: entry.broker });
  }
  checkBrokerDestination(url, refreshed);
  const retried = await send(refreshed);
  return scrubBrokeredResponse(retried, [
    ...brokerScrubValues(brokered),
    ...brokerScrubValues(refreshed),
    ...extraScrub,
  ]);
}
