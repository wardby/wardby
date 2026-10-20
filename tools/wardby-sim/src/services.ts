// TEST ONLY (wardby-sim). The services one simulator process serves, built from its
// environment:
//
//   WARDBY_SIM_GIT_ROOT             where simulated repositories live (default: a temp dir)
//   WARDBY_SIM_GITHUB_APP_ID        the simulated App's id (default 424242)
//   WARDBY_SIM_GITHUB_APP_SLUG      its slug (default wardby-sim)
//   WARDBY_SIM_GITHUB_APP_OWNER     its owner account (default sim-owner)
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubSim } from "./github/service.js";
import { createNpmService } from "./registry/npm.js";
import { createOsvService } from "./registry/osv.js";
import { createPypiServices } from "./registry/pypi.js";
import type { SimService } from "./service.js";
import { createSlackService } from "./slack/web.js";

export interface SimConfig {
  env: NodeJS.ProcessEnv;
}

export function buildServices(config: SimConfig): SimService[] {
  const env = config.env;
  const github = createGitHubSim({
    ...(env.WARDBY_SIM_GIT_ROOT ? { gitRoot: env.WARDBY_SIM_GIT_ROOT } : {}),
    app: {
      ...(env.WARDBY_SIM_GITHUB_APP_ID ? { id: Number(env.WARDBY_SIM_GITHUB_APP_ID) } : {}),
      ...(env.WARDBY_SIM_GITHUB_APP_SLUG ? { slug: env.WARDBY_SIM_GITHUB_APP_SLUG } : {}),
      ...(env.WARDBY_SIM_GITHUB_APP_OWNER ? { ownerLogin: env.WARDBY_SIM_GITHUB_APP_OWNER } : {}),
    },
  });
  return [
    github.service,
    github.gitService,
    createSlackService(),
    createNpmService(),
    ...createPypiServices(),
    createOsvService(),
  ];
}

/** Every route of every service, for the route table check. */
export function allRouteDefs(): { service: string; method: string; pattern: string }[] {
  return buildServices({ env: { WARDBY_SIM_GIT_ROOT: join(tmpdir(), "wardby-sim-route-table") } }).flatMap((service) =>
    service.routes().map((route) => ({ service: service.name, ...route })),
  );
}
