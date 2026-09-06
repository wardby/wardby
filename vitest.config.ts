import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Same dotenv-flow cascade the CLI loads (src/env.ts) — so
    // DATABASE_URL/etc. reach tests without exporting them by hand before
    // every `npm test`.
    setupFiles: ["./src/env.ts"],
  },
});
