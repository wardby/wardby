import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "deploy/**/*.test.mjs"],
    // Tests explicitly include .env.local; dotenv-flow normally omits it when
    // NODE_ENV=test. Shell/CI variables remain highest priority.
    setupFiles: ["./vitest.setup.ts"],
    // *.contract.test.ts hits a real, billed, network-dependent third-party
    // API (unlike the *.test.ts database suites, which are free/local/
    // deterministic against docker-compose Postgres and should run by
    // default). Run those explicitly via `npm run test:contract`.
    exclude: [...configDefaults.exclude, "**/*.contract.test.ts"],
  },
});
