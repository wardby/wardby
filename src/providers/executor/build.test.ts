import { describe, expect, it } from "vitest";
import { NativeEngine } from "../../core/engine-native.js";
import type { LlmProvider } from "../llm/types.js";
import type { Datastore } from "../datastore/types.js";
import type { SecretCipher } from "../secrets/types.js";
import { buildExecutor } from "./build.js";
import { InProcessExecutor } from "./in-process.js";
import { DbosExecutor } from "./dbos.js";

const llm = {} as LlmProvider;
const datastore = {} as Datastore;
const secrets = {} as SecretCipher;
const providers = { llm, engine: new NativeEngine(), datastore, secrets };

describe("buildExecutor", () => {
  it("builds the in-process executor by default", () => {
    expect(buildExecutor({ executor: "in-process" }, providers, undefined, {})).toBeInstanceOf(InProcessExecutor);
  });

  it("builds the DBOS executor when EXECUTOR=dbos and a database url and executor id are present", () => {
    const executor = buildExecutor({ executor: "dbos" }, providers, undefined, {
      DATABASE_URL: "postgresql://reevo:reevo@localhost:55432/reevo",
      DBOS_EXECUTOR_ID: "scheduler-1",
    });
    expect(executor).toBeInstanceOf(DbosExecutor);
    expect(typeof executor.launch).toBe("function");
    expect(typeof executor.close).toBe("function");
  });

  it("fails fast for EXECUTOR=dbos without any database url", () => {
    expect(() => buildExecutor({ executor: "dbos" }, providers, undefined, {})).toThrow(/DBOS_SYSTEM_DATABASE_URL/);
  });

  it("fails fast for EXECUTOR=dbos without DBOS_EXECUTOR_ID rather than defaulting to a shared id", () => {
    expect(() =>
      buildExecutor({ executor: "dbos" }, providers, undefined, {
        DATABASE_URL: "postgresql://reevo:reevo@localhost:55432/reevo",
      }),
    ).toThrow(/DBOS_EXECUTOR_ID, unique per running process/);
  });

  it("rejects an unknown executor kind", () => {
    expect(() => buildExecutor({ executor: "temporal" as never }, providers, undefined, {})).toThrow(
      /EXECUTOR "temporal"/,
    );
  });
});
