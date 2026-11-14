import { jwtVerify } from "jose";

/** Audience the Substrate egress gateway stamps on actor JWTs sent to the coding proxy. */
export const ACTOR_JWT_AUDIENCE = "wardby-coding-proxy";

export type IdentityResult =
  { ok: true; subject: string } | { ok: false; code: "missing" | "malformed" | "invalid" | "wrong_subject" };

/**
 * Verifies that a request to the coding proxy carries an actor JWT for the
 * expected Substrate actor (the run's paired tool actor).
 *
 * Failures return a fixed code only. The token and jose's error message are
 * never returned or logged, so they cannot reach run records or operator logs.
 */
export function createActorIdentityVerifier(options: { issuer: string; jwks: Parameters<typeof jwtVerify>[1] }) {
  return async (authorization: string | undefined, expectedSubject: string): Promise<IdentityResult> => {
    if (authorization === undefined) return { ok: false, code: "missing" };
    const match = /^Bearer ([\w-]+\.[\w-]+\.[\w-]+)$/.exec(authorization);
    if (!match) return { ok: false, code: "malformed" };
    try {
      const { payload } = await jwtVerify(match[1], options.jwks, {
        issuer: options.issuer,
        audience: ACTOR_JWT_AUDIENCE,
      });
      if (payload.sub !== expectedSubject) return { ok: false, code: "wrong_subject" };
      return { ok: true, subject: payload.sub };
    } catch {
      return { ok: false, code: "invalid" };
    }
  };
}
