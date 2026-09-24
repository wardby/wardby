/**
 * Single runtime load point for environment configuration. dotenv-flow uses
 * its standard environment cascade; Vitest has a separate explicit cascade in
 * vitest.setup.ts because dotenv-flow normally omits .env.local in test mode.
 * Imported for its side effect only, before any module reads process.env.
 *
 * It is also where the process's HTTP runtime is installed (see
 * core/http-runtime.ts): same contract — it has to happen before any other
 * module does anything — and every entry point already imports this file first.
 */
import "./core/http-runtime.js";
import dotenvFlow from "dotenv-flow";
import { join, resolve } from "node:path";

const projectDir = resolve(process.env.WARDBY_PROJECT_DIR || process.cwd());

// A quickstart installation owns this directory, so load it before an
// application's root env files. dotenv-flow never overwrites an existing
// process variable, preserving explicit shell/container configuration as the
// highest-priority source in either mode.
dotenvFlow.config({ path: join(projectDir, ".wardby"), silent: true });
dotenvFlow.config({ path: projectDir });
