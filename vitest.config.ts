import { defineConfig, configDefaults } from "vitest/config";

// "#prisma" (package.json "imports") points at dist/ by default; tests run
// from source, so resolve its "wardby-source" condition (src/generated/prisma).
// The rest is Vitest's own default for Vite 6+ (Vite's server conditions minus
// "module"), which a user-set list replaces rather than extends.
const sourceConditions = ["wardby-source", "node", "development|production"];

// *.contract.test.ts hits a real, billed, network-dependent third-party
// API (unlike the *.test.ts database suites, which are free/local/
// deterministic against docker-compose Postgres and should run by
// default). Run those explicitly via `npm run test:contract`.
// *.release.test.ts is the release regression suite: it needs its own
// set-up (every log level, captured for the secret sweep), so it runs
// only under `npm run test:release` (vitest.release.config.ts).
const NEVER = [...configDefaults.exclude, "**/*.contract.test.ts", "**/*.release.test.ts"];

// Test categories, named by file suffix. A project's include and exclude
// must not overlap another project's: a file in two projects runs twice, and a
// file in none is silently dropped. `npx vitest list --filesOnly` must list
// the same files, once each, as the union of the per-project lists.
// Two files drive Chromium without ".browser" in their name (renaming them would conflict with
// upstream syncs); the renderer one skips when Chromium is missing, so CI must run it in the
// browser project, where Chromium is installed.
const BROWSER_UNSUFFIXED = ["src/mcp/auth/self-hosted/browser.test.ts", "src/renderer/chrome.test.ts"];
const BROWSER = ["**/*.browser*.test.ts", ...BROWSER_UNSUFFIXED];
const DATABASE = ["**/*.database.test.{ts,mjs}"];
const INTEGRATION = ["**/*.{integration,docker,acceptance}.test.ts"];

export default defineConfig({
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    // Tests explicitly include .env.local; dotenv-flow normally omits it when
    // NODE_ENV=test. Shell/CI variables remain highest priority.
    setupFiles: ["./vitest.setup.ts"],
    // Database suites run migrations against Postgres and need more than Vitest's 5 s default
    // when CI workers contend for CPU; 10 s keeps a hung test failing quickly.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    exclude: NEVER,
    projects: [
      // Headless Chromium against the built dist/web-assets (npm run build:web).
      {
        extends: true,
        test: { name: "browser", include: ["src/**/*.browser*.test.ts", ...BROWSER_UNSUFFIXED], exclude: NEVER },
      },
      // Needs Postgres (DATABASE_URL), migrated.
      {
        extends: true,
        test: {
          name: "database",
          include: [
            "src/**/*.database.test.ts",
            "tools/**/*.database.test.ts",
            "deploy/**/*.database.test.mjs",
            "scripts/**/*.database.test.mjs",
          ],
          exclude: [...NEVER, ...BROWSER, ...INTEGRATION],
        },
      },
      // Docker, Kubernetes, native-worker and other out-of-process suites; most
      // are opt-in through a WARDBY_*_TEST variable and skip without it.
      {
        extends: true,
        test: {
          name: "integration",
          include: ["src/**/*.{integration,docker,acceptance}.test.ts"],
          exclude: [...NEVER, ...BROWSER, ...DATABASE],
        },
      },
      // The simulators, the deploy modules and the scripts.
      {
        extends: true,
        test: {
          name: "tools",
          include: ["tools/**/*.test.ts", "deploy/**/*.test.mjs", "scripts/**/*.test.mjs"],
          exclude: [...NEVER, ...BROWSER, ...DATABASE, ...INTEGRATION],
        },
      },
      // Everything else under src/. About 45 of these files need DATABASE_URL
      // without carrying ".database" in their name (renaming them would
      // conflict with every upstream sync); they skip when it is unset.
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}"],
          exclude: [...NEVER, ...BROWSER, ...DATABASE, ...INTEGRATION],
        },
      },
    ],
  },
});
