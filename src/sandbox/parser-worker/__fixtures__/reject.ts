import { parentPort } from "node:worker_threads";
if (parentPort) {
  const port = parentPort;
  port.on("message", () => port.postMessage({ ok: false, message: "fixture_reject" }));
}
