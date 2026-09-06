import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { safeFetch } from "../dist/sandbox/safe-fetch.js";
import { FETCH_RESPONSE_BYTES } from "../dist/sandbox/limits.js";

if (!global.gc) throw new Error("Run with node --expose-gc after npm run build.");
global.gc();
const baseline = process.memoryUsage().rss;
let peak = baseline;
let produced = 0;
const chunkSize = 64 * 1024;
// A lazy, endless response must stop at the bound, not allocate its full source.
const response = Object.assign(new Readable({
  read() {
    produced += chunkSize;
    this.push(Buffer.alloc(chunkSize, "a"));
    peak = Math.max(peak, process.memoryUsage().rss);
  },
}), { statusCode: 200, statusMessage: "OK", headers: {} });
await assert.rejects(safeFetch("https://public.example", {}, {
  resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  connect: async () => response,
}), /fetch_response_limit/);
assert.equal(response.destroyed, true);
assert.ok(produced <= FETCH_RESPONSE_BYTES + 2 * chunkSize, "Response read beyond bounded stream overhead.");
assert.ok(peak - baseline < 64 * 1024 * 1024, "Unexpected process-memory amplification.");
console.log(JSON.stringify({ result: "PASS", assertions: 4, producedBytes: produced, peakRssGrowthBytes: peak - baseline }));
