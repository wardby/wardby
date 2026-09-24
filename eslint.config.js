// Flat config (ESLint 10). Type-checked rules need a tsconfig project, so
// they're scoped to src/**/*.ts only -- root config files (vitest.*.ts) and
// scripts/**/*.mjs aren't part of that project and get a plain (non-type-
// aware) JS pass instead. Slower than a syntax-only lint -- meant for CI /
// pre-merge, not every keystroke.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "src/sandbox/generated/**",
      "**/coverage/**",
      "spikes/**",
      ".claude/**",
    ],
  },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      "no-console": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Every hit repo-wide (test fakes AND real src: auth-provider stubs
      // that unconditionally throw, LLM countTokens estimators, sandbox
      // bridge handlers) is a function implementing a shared async
      // interface where only SOME implementations need to await -- not a
      // bug this rule can usefully catch here.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    // CLI stdout/stderr is this file's actual UI, not server logging through
    // pino -- not the same category of "console usage" the no-console rule
    // exists to catch. src/tools/* are the same category: one-shot developer
    // commands an operator runs from a terminal (npm run capture:autopilot),
    // never part of a serving process.
    files: [
      "src/cli.ts",
      "src/wardby-bin.ts",
      "src/quickstart/*.ts",
      "src/mcp/auth/self-hosted/cli.ts",
      "src/tools/*.ts",
    ],
    rules: { "no-console": "off" },
  },
  {
    // The sandboxed-code console shim -- runs as prelude source inside
    // QuickJS, not host logging.
    files: ["src/sandbox/prelude.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Deliberate control-character rejection in user-supplied coding-agent
    // input (commit refs, prompts) -- not an accidental escape, the thing
    // this rule exists to catch.
    files: ["src/coding/profile.ts", "src/coding/protocol.ts"],
    rules: { "no-control-regex": "off" },
  },
  {
    // consistent-type-imports fights this codebase's established test-fake
    // idiom of an inline `import("mod").Type` annotation instead of a
    // top-of-file type import (avoids an unused-outside-this-one-spot import
    // in terse fakes) -- 49 of its 50 hits repo-wide are exactly this
    // pattern. no-console is test-runner diagnostic output (e.g.
    // "DATABASE_URL not set, skipping" via console.warn) meant to print
    // directly to the terminal running `npm test` -- the same category as
    // CLI stdout, not server logging through pino -- plus
    // host-functions.test.ts's test that deliberately intercepts
    // console.log to verify secret redaction.
    files: ["src/**/*.test.ts"],
    rules: {
      "@typescript-eslint/consistent-type-imports": "off",
      "no-console": "off",
      // 214 of 216 repo-wide hits for this cluster are test-double `any`
      // (fake Prisma-shaped DB objects, loosely-typed mock args) -- the
      // same deliberate loose-typing convention as the two exceptions
      // above. Rewriting every test fake to satisfy Prisma's exact
      // generated generic signatures would make one-off test doubles more
      // brittle for no real safety benefit; production code (src/**/*.ts
      // outside tests) keeps these rules at "error".
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-call": "off",
    },
  },
  {
    // Root config files and standalone ops scripts: non-type-checked rules,
    // no tsconfig project (they aren't part of tsconfig.json's `include`).
    files: ["*.{js,mjs,ts}", "scripts/**/*.mjs", "deploy/**/*.mjs"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  eslintConfigPrettier,
);
