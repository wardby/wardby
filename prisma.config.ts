// Prisma CLI configuration (Prisma 7 no longer reads DATABASE_URL from the
// schema or loads .env files itself). Environment is loaded with dotenv-flow,
// the same loader and precedence the app uses (shell variables win over files).
//
// `?? ""` rather than prisma/config's env(): env() throws when the variable is
// unset, but `prisma generate` / `prisma validate` must run without a database
// (npm `prepare`, image builds, `npm pack`). Commands that need a connection
// fail cleanly with "Connection url is empty".
//
// SHADOW_DATABASE_URL is only needed for `prisma migrate diff
// --from-migrations` (the schema drift check); point it at a throwaway
// database, never a real one.
import dotenvFlow from "dotenv-flow";
import { join, resolve } from "node:path";
import { defineConfig } from "prisma/config";

// Mirrors src/env.ts: a quickstart installation's .wardby/ first, then the
// project root's cascade. dotenv-flow never overwrites an existing variable.
const projectDir = resolve(process.env.WARDBY_PROJECT_DIR || process.cwd());
dotenvFlow.config({ path: join(projectDir, ".wardby"), silent: true });
dotenvFlow.config({ path: projectDir, silent: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "",
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
