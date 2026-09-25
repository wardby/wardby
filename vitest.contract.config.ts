import { defineConfig } from "vitest/config";

// Separate config (not just CLI --exclude, which only adds to the main
// config's exclude list rather than overriding it) so `npm run
// test:contract` can target *.contract.test.ts despite the main config
// excluding it from the default `npm test` run.
// "#prisma" (package.json "imports") points at dist/ by default; tests run
// from source, so resolve its "wardby-source" condition (src/generated/prisma).
// The rest is Vitest's own default for Vite 6+ (Vite's server conditions minus
// "module"), which a user-set list replaces rather than extends.
const sourceConditions = ["wardby-source", "node", "development|production"];

export default defineConfig({
  ssr: { resolve: { conditions: sourceConditions } },
  test: {
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.contract.test.ts"],
  },
});
