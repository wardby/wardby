import { relayStoreContract } from "./relay-store-contract.js";
import { MemoryRelayStore } from "./memory-relay-store.js";

relayStoreContract("memory", async (token, maxBytes) => {
  const store = new MemoryRelayStore();
  store.register(token, maxBytes);
  return store;
});
