import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Same dotenv-flow cascade the CLI loads (src/env.ts) — so
    // DATABASE_URL/etc. reach tests without exporting them by hand before
    // every `npm test`.
    setupFiles: ["./src/env.ts"],
    // *.contract.test.ts hits a real, billed, network-dependent third-party
    // API (unlike the *.test.ts database suites, which are free/local/
    // deterministic against docker-compose Postgres and should run by
    // default). Run those explicitly via `npm run test:contract`.
    exclude: [...configDefaults.exclude, "**/*.contract.test.ts"],
  },
});
