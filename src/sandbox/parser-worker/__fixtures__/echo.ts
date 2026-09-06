import { parentPort } from "node:worker_threads";
if (parentPort) {
  const port = parentPort;
  port.on("message", (request: unknown) => port.postMessage({ ok: true, value: request }));
}
