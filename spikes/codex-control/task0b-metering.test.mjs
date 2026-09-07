import test from "node:test";
import assert from "node:assert/strict";
import { actualCostUsd, completedUsageFromSseFrame, estimateReservationUsd } from "./task0b-metering.mjs";

test("reservation treats each UTF-8 byte as both fresh input and a possible cache write", () => {
  const body = { input: "hello", max_output_tokens: 128 };
  const expected = (Buffer.byteLength(JSON.stringify(body)) * (0.2 + 0.25) + 128 * 1.2) / 1_000_000;
  assert.equal(estimateReservationUsd(body), expected);
});

test("actual cost separates cached input", () => {
  assert.equal(
    actualCostUsd({
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 400, cache_write_tokens: 500 },
      output_tokens: 100,
    }),
    0.000373,
  );
});

test("completed SSE frame exposes authoritative usage", () => {
  const usage = { input_tokens: 7, output_tokens: 3, total_tokens: 10 };
  const frame = `event: response.completed\ndata: ${JSON.stringify({
    type: "response.completed",
    response: { usage },
  })}`;
  assert.deepEqual(completedUsageFromSseFrame(frame), usage);
  assert.equal(completedUsageFromSseFrame("event: response.output_text.delta\ndata: {}"), null);
});

test("invalid authoritative usage fails closed", () => {
  assert.throws(
    () => actualCostUsd({ input_tokens: 2, input_tokens_details: { cached_tokens: 3 } }),
    /invalid authoritative usage/,
  );
});
