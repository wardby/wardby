import { describe } from "vitest";
import { MemoryNativeCanaryStore } from "./substrate-canary-store.js";
import { canaryStoreContract } from "./substrate-canary-store.test-support.js";

describe("MemoryNativeCanaryStore", () => {
  canaryStoreContract(() => new MemoryNativeCanaryStore());
});
