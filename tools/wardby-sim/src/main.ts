// TEST ONLY (wardby-sim). Process entry point.
//
//   WARDBY_SIM_PORT            listen port (default 8080)
//   WARDBY_SIM_HOST            listen address (default 0.0.0.0)
//   WARDBY_SIM_TLS_CERT_FILE   PEM certificate; with WARDBY_SIM_TLS_KEY_FILE, serve https
//   WARDBY_SIM_TLS_KEY_FILE    PEM key
//
// Service-specific variables are read in services.ts.
import { readFileSync } from "node:fs";
import { createSimServer } from "./server.js";
import { buildServices } from "./services.js";

const env = process.env;
const certFile = env.WARDBY_SIM_TLS_CERT_FILE;
const keyFile = env.WARDBY_SIM_TLS_KEY_FILE;
if (Boolean(certFile) !== Boolean(keyFile)) {
  process.stderr.write("wardby-sim: set both WARDBY_SIM_TLS_CERT_FILE and WARDBY_SIM_TLS_KEY_FILE, or neither\n");
  process.exit(2);
}
const sim = createSimServer({
  services: buildServices({ env }),
  ...(certFile && keyFile ? { tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) } } : {}),
});
const port = Number(env.WARDBY_SIM_PORT ?? "8080");
const url = await sim.listen(port, env.WARDBY_SIM_HOST ?? "0.0.0.0");
process.stdout.write(`wardby-sim listening on ${url} (TEST ONLY)\n`);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void sim.close().then(() => process.exit(0));
  });
}
