// TEST ONLY (wardby-sim). Process entry point.
//
//   WARDBY_SIM_PORT            plain http listen port (default 8080)
//   WARDBY_SIM_HOST            listen address (default 0.0.0.0)
//   WARDBY_SIM_TLS_CERT_FILE   PEM certificate (deploy/kind-coding/sim-ca.sh); with
//   WARDBY_SIM_TLS_KEY_FILE    the PEM key, also serve https on WARDBY_SIM_TLS_PORT (default
//                              8443), sharing the same state. Missing files (an optional
//                              Secret not created) leave https off.
//
// Service-specific variables are read in services.ts.
import { existsSync, readFileSync } from "node:fs";
import { createSimServer, type SimServer } from "./server.js";
import { buildServices } from "./services.js";

const env = process.env;
const host = env.WARDBY_SIM_HOST ?? "0.0.0.0";
const certFile = env.WARDBY_SIM_TLS_CERT_FILE;
const keyFile = env.WARDBY_SIM_TLS_KEY_FILE;
if (Boolean(certFile) !== Boolean(keyFile)) {
  process.stderr.write("wardby-sim: set both WARDBY_SIM_TLS_CERT_FILE and WARDBY_SIM_TLS_KEY_FILE, or neither\n");
  process.exit(2);
}
const services = buildServices({ env });
const plain = createSimServer({ services });
const servers: SimServer[] = [plain];
process.stdout.write(
  `wardby-sim listening on ${await plain.listen(Number(env.WARDBY_SIM_PORT ?? "8080"), host)} (TEST ONLY)\n`,
);
if (certFile && keyFile) {
  if (existsSync(certFile) && existsSync(keyFile)) {
    const tls = createSimServer({
      services,
      state: plain.state,
      tls: { cert: readFileSync(certFile), key: readFileSync(keyFile) },
    });
    servers.push(tls);
    process.stdout.write(
      `wardby-sim listening on ${await tls.listen(Number(env.WARDBY_SIM_TLS_PORT ?? "8443"), host)} (TEST ONLY)\n`,
    );
  } else {
    process.stdout.write("wardby-sim: TLS certificate files not present; https is off\n");
  }
}
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void Promise.all(servers.map((server) => server.close())).then(() => process.exit(0));
  });
}
