import { describeSubstrateTemplateStoreContract } from "./template-store.contract.test-support.js";
import { MemorySubstrateTemplateStore } from "./template-store.js";

let counter = 0;
describeSubstrateTemplateStoreContract("MemorySubstrateTemplateStore", {
  store: () => new MemorySubstrateTemplateStore(),
  id: () => `wardby-tool-${(counter++).toString(16).padStart(16, "0")}`,
});
