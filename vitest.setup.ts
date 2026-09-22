// Tests load modules directly, not through cli.ts/env.ts, so the HTTP runtime
// has to be installed here too — several suites import (transitively) the
// Kubernetes client, which hijacks the global dispatcher process-wide and
// breaks Node's built-in fetch for every suite that follows in the same worker.
import "./src/core/http-runtime.js";
import dotenvFlow from "dotenv-flow";

// dotenv-flow omits .env.local for NODE_ENV=test by default. Tests opt into
// local settings while retaining dedicated test files as the final override.
dotenvFlow.config({
  files: [".env", ".env.local", ".env.test", ".env.test.local"],
});
