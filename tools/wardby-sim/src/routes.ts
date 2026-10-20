// TEST ONLY (wardby-sim). The route table: every route the simulator answers, and whether
// its behaviour has been checked against the real service (task 11 of the phase 2 plan).
//
// A route is `verified` only when a recorded, redacted response from the real service
// is replayed against it by `npm run test:contract`; `recording` names that fixture.
// Everything else is `unverified`: what a Flow G run finds through an unverified route is
// UNCONFIRMED until it is reproduced against production code without the simulator, and
// each Flow G record lists the unverified routes it went through.
//
// routes.test.ts keeps this table equal to the routes the services actually register.

export interface RouteEntry {
  service: string;
  method: string;
  /** The path pattern after the service prefix, in matchPath syntax. */
  pattern: string;
  verified: boolean;
  /** The recorded real response a verified route is replayed against. */
  recording?: string;
  /** Where the modelled behaviour comes from, and what it leaves out. */
  note: string;
}

function unverified(service: string, method: string, pattern: string, note: string): RouteEntry {
  return { service, method, pattern, verified: false, note };
}

export const ROUTES: readonly RouteEntry[] = [];

export function routeKey(entry: { service: string; method: string; pattern: string }): string {
  return `${entry.service} ${entry.method} ${entry.pattern}`;
}

export function routeCounts(): { verified: number; unverified: number } {
  const verified = ROUTES.filter((route) => route.verified).length;
  return { verified, unverified: ROUTES.length - verified };
}

void unverified;
