import { defineConfig } from "vitest/config";

// The release regression suite (Tier 1): one *.release.test.ts file per promise, each a
// matrix or a seeded property rather than a single example. Deterministic, no network, no
// spend; the database suites skip without DATABASE_URL like every *.database.test.ts.
//
// Separate from vitest.config.ts (which excludes these files) because the suite needs its own
// set-up: every log level on, and every log line captured for the secret sweep
// (src/release/setup.test-support.ts). Under the default config a debug line would never be written,
// so a sweep there could pass without ever seeing the line that leaks.
//
// "#prisma" (package.json "imports") points at dist/ by default; tests run from source, so
// resolve its "wardby-source" condition (src/generated/prisma), as vitest.config.ts does.
const sourceConditions = ["wardby-source", "node", "development|production"];

export default defineConfig({
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    include: ["src/**/*.release.test.ts"],
    setupFiles: ["./vitest.setup.ts", "./src/release/setup.test-support.ts"],
    // Applied before any module loads, so loggers created at import time log at every level too.
    env: { LOG_LEVEL: "trace" },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
