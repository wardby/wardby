import { parentPort } from "node:worker_threads";
if (parentPort) {
  parentPort.on("message", () => {
    // Simulates a pathological synchronous parse that never yields — this
    // is what proves the pool's timeout can reclaim a genuinely hung
    // worker, without depending on any real library's specific behavior.
    let _busyWork = 0;
    while (true) _busyWork++;
  });
}
