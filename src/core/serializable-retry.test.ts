import { describe, expect, it, vi } from "vitest";
import { preferIndexScans, withSerializableRetry } from "./serializable-retry.js";

const conflict = () => Object.assign(new Error("could not serialize access"), { code: "P2034" });
const noSleep = async () => {};

describe("withSerializableRetry", () => {
  it("returns the first success without retrying", async () => {
    const fn = vi.fn(async () => 7);
    expect(await withSerializableRetry(fn, { sleep: noSleep })).toBe(7);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a serialization conflict and returns the later success", async () => {
    const fn = vi.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce("ok");
    const sleep = vi.fn(noSleep);
    expect(await withSerializableRetry(fn, { attempts: 3, sleep })).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("recognises a conflict at COMMIT (unwrapped driver adapter error)", async () => {
    const atCommit = Object.assign(new Error("commit"), {
      name: "DriverAdapterError",
      cause: { originalCode: "40001" },
    });
    const fn = vi.fn().mockRejectedValueOnce(atCommit).mockResolvedValueOnce("ok");
    expect(await withSerializableRetry(fn, { sleep: noSleep })).toBe("ok");
  });

  it("rethrows the last conflict once the attempts run out", async () => {
    const fn = vi.fn(async () => {
      throw conflict();
    });
    await expect(withSerializableRetry(fn, { attempts: 3, sleep: noSleep })).rejects.toMatchObject({ code: "P2034" });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries any other error", async () => {
    const other = Object.assign(new Error("unique"), { code: "P2002", meta: { modelName: "Agent" } });
    const fn = vi.fn(async () => {
      throw other;
    });
    await expect(withSerializableRetry(fn, { sleep: noSleep })).rejects.toBe(other);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("preferIndexScans", () => {
  it("turns sequential scans off for the current transaction only", async () => {
    const tx = { $executeRawUnsafe: vi.fn(async () => 0) };
    await preferIndexScans(tx);
    expect(tx.$executeRawUnsafe).toHaveBeenCalledExactlyOnceWith("SET LOCAL enable_seqscan = off");
  });
});
