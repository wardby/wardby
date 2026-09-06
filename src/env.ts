/**
 * Single load point for environment configuration. dotenv-flow cascades
 * .env -> .env.<NODE_ENV> -> .env.local -> .env.<NODE_ENV>.local (later
 * overriding earlier), so one file per concern replaces exporting vars by
 * hand before every command. Imported for its side effect only — must run
 * before any module reads process.env, so it's always the first import.
 */
import dotenvFlow from "dotenv-flow";

dotenvFlow.config();
