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

dotenvFlow.config();
