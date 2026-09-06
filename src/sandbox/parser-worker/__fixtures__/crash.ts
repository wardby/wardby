import { parentPort } from "node:worker_threads";
if (parentPort) {
  parentPort.on("message", () => {
    throw new Error("fixture_crash");
  });
}
