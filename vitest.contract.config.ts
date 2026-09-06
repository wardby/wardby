import { defineConfig } from "vitest/config";

// Separate config (not just CLI --exclude, which only adds to the main
// config's exclude list rather than overriding it) so `npm run
// test:contract` can target *.contract.test.ts despite the main config
// excluding it from the default `npm test` run.
export default defineConfig({
  test: {
    setupFiles: ["./src/env.ts"],
    include: ["**/*.contract.test.ts"],
  },
});
