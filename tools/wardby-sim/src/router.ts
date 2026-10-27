// TEST ONLY (wardby-sim). A small method + path-pattern router; every route it holds is
// listed in routes.ts with its verified status (routes.test.ts keeps the two equal).
import { matchPath, type SimRequest, type SimResponse } from "./http.js";
import type { RouteContext } from "./service.js";

export type RouteHandler = (
  req: SimRequest,
  params: Record<string, string>,
  ctx: RouteContext,
) => Promise<SimResponse> | SimResponse;

export interface RouteDef {
  method: string;
  pattern: string;
}

export class Router {
  private readonly table: { method: string; pattern: string; handler: RouteHandler }[] = [];

  on(method: string, pattern: string, handler: RouteHandler): this {
    this.table.push({ method, pattern, handler });
    return this;
  }

  routes(): RouteDef[] {
    return this.table.map(({ method, pattern }) => ({ method, pattern }));
  }

  async handle(req: SimRequest, ctx: RouteContext): Promise<SimResponse | undefined> {
    for (const route of this.table) {
      if (route.method !== req.method) continue;
      const params = matchPath(route.pattern, req.path);
      if (params) return route.handler(req, params, ctx);
    }
    return undefined;
  }
}
