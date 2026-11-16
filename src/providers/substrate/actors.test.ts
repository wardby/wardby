import { describe, expect, it } from "vitest";
import {
  SubstrateAlreadyExistsError,
  SubstrateExhaustedError,
  SubstrateNotFoundError,
  SubstrateTemplateMissingError,
  SubstrateUnavailableError,
  type ActorTemplateSpec,
} from "./api.js";
import {
  createFreshActor,
  deleteActorWithPolicy,
  ensureTemplate,
  namedCall,
  reportCallFailure,
  substrateErrorCode,
  type SubstrateCallFailure,
} from "./actors.js";
import { FakeSubstrateApi } from "./fake-api.js";

const atespace = "wardby-runs";
const template: ActorTemplateSpec = {
  atespace,
  name: "wardby-agent-0123456789abcdef",
  containers: [{ name: "agent", image: "r@sha256:aa" }],
  volumes: [],
  cpuMillicores: 1000,
  memoryBytes: 2 ** 30,
  snapshotFidelity: "MEMORY",
};

function setup() {
  const api = new FakeSubstrateApi({ workers: 1 });
  const reports: SubstrateCallFailure[] = [];
  const call = namedCall("run-1", (failure) => reports.push(failure));
  return { api, reports, call };
}

describe("substrateErrorCode", () => {
  it.each([
    new SubstrateAlreadyExistsError("x"),
    new SubstrateExhaustedError("x"),
    new SubstrateNotFoundError("x"),
    new SubstrateUnavailableError("x"),
  ])("is the fixed code of %o", (error) => {
    expect(substrateErrorCode(error)).toBe(error.code);
  });

  it("never reads another error's message", () => {
    expect(substrateErrorCode(new Error("substrate_resource_exhausted quoting a template"))).toBe("unexpected");
  });
});

describe("ensureTemplate", () => {
  it("creates once and recreates a golden-failed template once", async () => {
    const { api, call } = setup();
    await ensureTemplate(api, template, call);
    expect(api.templates.size).toBe(1);
    api.failGoldenSnapshot(atespace, template.name);
    await ensureTemplate(api, template, call);
    expect(api.templates.has(`${atespace}/${template.name}`)).toBe(true);
    expect(api.goldenFailed.has(`${atespace}/${template.name}`)).toBe(false);
  });

  it("does not delete a golden-failed template its hook refuses to rebuild", async () => {
    const { api, call } = setup();
    await ensureTemplate(api, template, call);
    api.failGoldenSnapshot(atespace, template.name);
    await expect(
      ensureTemplate(api, template, call, async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(api.goldenFailed.has(`${atespace}/${template.name}`)).toBe(true);
  });
});

describe("createFreshActor", () => {
  it("never takes over an existing actor", async () => {
    const { api, call } = setup();
    await ensureTemplate(api, template, call);
    await api.createActor(atespace, "a", template.name);
    await api.putEgressPolicy(atespace, "a", []);
    api.setState(atespace, "a", "RUNNING");
    await createFreshActor(api, atespace, "a", template.name, call);
    expect(api.actors.get(`${atespace}/a`)?.state).toBe("SUSPENDED");
    expect(api.egressPolicies.has(`${atespace}/a`)).toBe(false);
  });

  it("rethrows the AlreadyExists when the old actor cannot be deleted", async () => {
    const { api, call } = setup();
    await ensureTemplate(api, template, call);
    await api.createActor(atespace, "a", template.name);
    api.deleteActor = async () => {
      throw new Error("boom");
    };
    await expect(createFreshActor(api, atespace, "a", template.name, call)).rejects.toBeInstanceOf(
      SubstrateAlreadyExistsError,
    );
  });

  it("re-ensures once on a missing template, without reporting the first answer", async () => {
    const { api, call, reports } = setup();
    let calls = 0;
    await createFreshActor(api, atespace, "a", template.name, call, async () => {
      calls += 1;
      await ensureTemplate(api, template, call);
    });
    expect(calls).toBe(1);
    expect(api.actors.has(`${atespace}/a`)).toBe(true);
    expect(reports).toEqual([]);
  });

  it("rejects a missing template without the hook, and reports it", async () => {
    const { api, call, reports } = setup();
    await expect(createFreshActor(api, atespace, "a", template.name, call)).rejects.toBeInstanceOf(
      SubstrateTemplateMissingError,
    );
    expect(reports).toEqual([
      { runId: "run-1", substrateCall: "createActor", errorCode: "substrate_template_missing" },
    ]);
  });
});

describe("deleteActorWithPolicy", () => {
  it("deletes the policy, then the actor, and a missing one is success", async () => {
    const { api, call } = setup();
    await ensureTemplate(api, template, call);
    await api.createActor(atespace, "a", template.name);
    await deleteActorWithPolicy(api, atespace, "a");
    await deleteActorWithPolicy(api, atespace, "a");
    expect(api.actors.size).toBe(0);
  });
});

describe("namedCall", () => {
  it("reports fixed fields and rethrows", async () => {
    const { api, call, reports } = setup();
    const error = await api.createActor(atespace, "a", "missing").catch((e: unknown) => e);
    await expect(
      call("createActor", async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(reports).toEqual([
      { runId: "run-1", substrateCall: "createActor", errorCode: "substrate_template_missing" },
    ]);
  });

  it("does not report an error the caller says it recovers from", async () => {
    const { call, reports } = setup();
    await expect(
      call(
        "createActor",
        () => Promise.reject(new SubstrateNotFoundError("substrate_not_found")),
        (e) => e instanceof SubstrateNotFoundError,
      ),
    ).rejects.toBeInstanceOf(SubstrateNotFoundError);
    expect(reports).toEqual([]);
  });
});

describe("reportCallFailure", () => {
  const failure: SubstrateCallFailure = {
    runId: "run-1",
    substrateCall: "createActor",
    errorCode: "substrate_not_found",
  };

  it("never throws, whether the sink or the log fails", () => {
    expect(() =>
      reportCallFailure(
        failure,
        () => {
          throw new Error("sink");
        },
        { warn: () => undefined } as never,
      ),
    ).not.toThrow();
    expect(() =>
      reportCallFailure(failure, undefined, {
        warn: () => {
          throw new Error("log");
        },
      } as never),
    ).not.toThrow();
  });

  it("logs the fixed fields when there is no sink", () => {
    const logged: unknown[][] = [];
    reportCallFailure(failure, undefined, { warn: (...args: unknown[]) => logged.push(args) } as never);
    expect(logged).toEqual([[{ ...failure }, "substrate_call_failed"]]);
  });
});
