import { describe, expect, it } from "vitest";
import {
  CANARY_REPORT_WINDOW_MS,
  MemoryNativeCanaryStore,
  NATIVE_CANARY_TIMEOUT_MS,
  SUBSTRATE_NATIVE_GOLDEN_WAIT_MAX_SEC,
} from "./substrate-canary-store.js";
import { canaryStoreContract } from "./substrate-canary-store.test-support.js";

describe("MemoryNativeCanaryStore", () => {
  canaryStoreContract(() => new MemoryNativeCanaryStore());
});

describe("CANARY_REPORT_WINDOW_MS", () => {
  it("is at least the longest a canary can run: the longest golden wait plus the verdict timeout", () => {
    expect(SUBSTRATE_NATIVE_GOLDEN_WAIT_MAX_SEC).toBe(600);
    expect(CANARY_REPORT_WINDOW_MS).toBeGreaterThanOrEqual(
      SUBSTRATE_NATIVE_GOLDEN_WAIT_MAX_SEC * 1_000 + NATIVE_CANARY_TIMEOUT_MS,
    );
  });
});
