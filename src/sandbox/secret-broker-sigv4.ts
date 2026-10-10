/** AWS SigV4 for a brokered secret, using AWS's own signer. The tool never sees the keys. */
import { SignatureV4 } from "@smithy/signature-v4";
import { Sha256 } from "@aws-crypto/sha256-js";
import { parseSigV4Value } from "../core/secret-broker-config.js";
import type { BrokeredSecret, BrokerRequest } from "./secret-broker.js";

const SIGNER_HEADERS = ["authorization", "x-amz-date", "x-amz-security-token", "x-amz-content-sha256"];

/** Group query params by key so repeated keys survive (Object.fromEntries would drop them). */
function queryOf(url: URL): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    query[key] = all.length === 1 ? all[0] : all;
  }
  return query;
}

export async function signSigV4(
  request: BrokerRequest,
  secret: BrokeredSecret,
  now: Date = new Date(),
): Promise<BrokerRequest> {
  if (secret.broker.placement.kind !== "aws-sigv4") {
    throw new Error("signSigV4 needs an aws-sigv4 secret");
  }
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  for (const h of SIGNER_HEADERS) {
    if (h in headers) {
      throw new Error(`secret_broker_conflict: header "${h}" is set by the SigV4 signer for "${secret.name}"`);
    }
  }
  const { region, service } = secret.broker.placement;
  const signer = new SignatureV4({
    credentials: parseSigV4Value(secret.value),
    region,
    service,
    sha256: Sha256,
    applyChecksum: service === "s3",
    uriEscapePath: service !== "s3",
  });
  const url = new URL(request.url);
  const signed = await signer.sign(
    {
      method: request.method,
      protocol: url.protocol,
      hostname: url.hostname,
      path: url.pathname,
      query: queryOf(url),
      headers: { ...headers, host: url.host },
      body: request.body,
    },
    { signingDate: now },
  );
  const out = Object.fromEntries(Object.entries(signed.headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  delete out.host; // safeFetch forbids setting Host; Node sets the same value from the URL.
  return { ...request, headers: out };
}
