// TEST ONLY (wardby-sim). The services one simulator process serves, built from its
// environment (see main.ts for the variables).
import type { SimService } from "./service.js";

export interface SimConfig {
  env: NodeJS.ProcessEnv;
}

export function buildServices(_config: SimConfig): SimService[] {
  return [];
}

/** Every route of every service, for the route table check. */
export function allRouteDefs(): { service: string; method: string; pattern: string }[] {
  return buildServices({ env: {} }).flatMap((service) =>
    service.routes().map((route) => ({ service: service.name, ...route })),
  );
}
