/**
 * Single runtime load point for environment configuration. dotenv-flow uses
 * its standard environment cascade; Vitest has a separate explicit cascade in
 * vitest.setup.ts because dotenv-flow normally omits .env.local in test mode.
 * Imported for its side effect only, before any module reads process.env.
 */
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();
