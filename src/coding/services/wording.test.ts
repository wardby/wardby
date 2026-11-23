import { describe, expect, it } from "vitest";
import {
  DECLARATION_UNAVAILABLE_SENTENCE,
  invalidDeclarationSentence,
  LAUNCHER_UNSUPPORTED_SENTENCE,
  notAllowedServiceSentence,
  SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE,
  serviceRefusal,
  serviceRefusalSentence,
  serviceUnreadyError,
  serviceUnreadyName,
  serviceUnreadySentence,
  unknownServiceSentence,
  unstartableServiceSentence,
  codexToolchainSentence,
  misplacedServiceSentence,
  setupWaitForSentence,
} from "./wording.js";
import type { ResolvedSidecarService } from "./catalog.js";

const FAKE_SERVICE: ResolvedSidecarService = {
  kind: "sidecar",
  name: "fakedb",
  version: "1.2.3-fake",
  image: `registry.example/fakedb-image@sha256:${"b".repeat(64)}`,
  port: 5999,
  serviceEnv: { FAKEDB_PASSWORD: "FAKE_SERVICE_ENV_VALUE_0001" },
  testEnv: {},
  readiness: {
    command: ["fakedb-ready", "-pFAKE_READINESS_ARG"],
    periodSeconds: 1,
    timeoutSeconds: 1,
    failureThreshold: 3,
  },
  startCommand: ["fakedb-serve", "--fake-start-arg"],
  resources: { cpuMillicores: 100, memoryMib: 64, diskMib: 64 },
  dataPath: "/var/lib/fakedb-data",
  writablePaths: [],
};

describe("service refusals", () => {
  it("carries the host sentence after the code in Run.error, and reads it back", () => {
    const error = serviceRefusal("service_not_allowed", notAllowedServiceSentence("redis"));
    expect(error).toBe(
      "service_not_allowed: This repository asks for `redis`, which this agent isn't allowed to use. An admin or the agent's owner can allow it.",
    );
    expect(serviceRefusalSentence(error)).toBe(notAllowedServiceSentence("redis"));
  });

  it("words the launcher refusal without naming a provider", () => {
    expect(LAUNCHER_UNSUPPORTED_SENTENCE).toBe(
      "This repository asks for services, which this wardby deployment can't start: services need the Kubernetes, Docker or Substrate job launcher.",
    );
  });

  it("words each unstartable reason with only the service's name", () => {
    const sentences = (["start_command_missing", "data_path_reserved", "setup_too_large"] as const).map((reason) =>
      unstartableServiceSentence({ name: FAKE_SERVICE.name, reason }),
    );
    expect(sentences).toEqual([
      "This repository asks for `fakedb`, which this wardby deployment can't start: its service catalog entry has no start command.",
      "This repository asks for `fakedb`, which this wardby deployment can't start: its service catalog entry's data path overlaps a directory the job launcher reserves.",
      "This repository asks for `fakedb`, which this wardby deployment can't start: its service catalog entry's environment and commands are too large for the job launcher.",
    ]);
    const text = JSON.stringify(sentences);
    for (const value of [
      FAKE_SERVICE.version,
      FAKE_SERVICE.image,
      String(FAKE_SERVICE.port),
      ...Object.values(FAKE_SERVICE.serviceEnv),
      ...(FAKE_SERVICE.startCommand ?? []),
      ...FAKE_SERVICE.readiness.command,
      FAKE_SERVICE.dataPath,
    ]) {
      expect(text).not.toContain(value);
    }
  });

  it("words the setup refusals (#589) with only the job's name", () => {
    expect(unstartableServiceSentence({ name: "app-migrations", reason: "setup_unsupported" })).toBe(
      "This repository asks for the setup job `app-migrations`, which this wardby deployment can't start: setup jobs are not supported on this launcher yet.",
    );
    expect(misplacedServiceSentence("app-migrations", "setup", "services")).toBe(
      "`.wardby/services.yaml` is invalid: `app-migrations` is a setup job; declare it under `setup:`.",
    );
    expect(misplacedServiceSentence("mysql", "sidecar", "setup")).toBe(
      "`.wardby/services.yaml` is invalid: `mysql` is a service, not a setup job; declare it under `services:`.",
    );
    expect(setupWaitForSentence("app-migrations", "mysql")).toBe(
      "`.wardby/services.yaml` is invalid: `app-migrations` needs `mysql`; declare it under `services:`.",
    );
  });

  it("words the toolchain refusals with only the toolchain's name", () => {
    expect(unstartableServiceSentence({ name: "python-dev", reason: "toolchain_unsupported" })).toBe(
      "This repository asks for the toolchain `python-dev`, which this wardby deployment can't start: toolchains are not supported on this launcher yet.",
    );
    expect(codexToolchainSentence("python-dev")).toBe(
      "This repository asks for the toolchain `python-dev`, which this agent can't use: toolchains are not supported for Codex agents yet.",
    );
    expect(codexToolchainSentence("Bad Name`")).toBe(
      "This repository asks for the toolchain, which this agent can't use: toolchains are not supported for Codex agents yet.",
    );
    expect(misplacedServiceSentence("python-dev", "toolchain")).toBe(
      "`.wardby/services.yaml` is invalid: `python-dev` is a toolchain; declare it under `toolchain:`.",
    );
    expect(misplacedServiceSentence("postgres", "sidecar")).toBe(
      "`.wardby/services.yaml` is invalid: `postgres` is a service, not a toolchain; declare it under `services:`.",
    );
  });

  it("falls back to the generic launcher sentence for a name that isn't a catalog name", () => {
    expect(unstartableServiceSentence({ name: "Bad Name`", reason: "setup_too_large" })).toBe(
      LAUNCHER_UNSUPPORTED_SENTENCE,
    );
  });

  it("words each refusal as the spec says", () => {
    expect(invalidDeclarationSentence("line 2: `postgres` is listed twice")).toBe(
      "`.wardby/services.yaml` is invalid: line 2: `postgres` is listed twice.",
    );
    expect(unknownServiceSentence("postgres", "18")).toBe(
      "This repository asks for `postgres 18`, which wardby's service catalog doesn't have.",
    );
    expect(
      serviceRefusalSentence(serviceRefusal("service_declaration_unavailable", DECLARATION_UNAVAILABLE_SENTENCE)),
    ).toBe(DECLARATION_UNAVAILABLE_SENTENCE);
  });

  it("words a resolved declaration whose instructions would exceed the task size limit", () => {
    expect(SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE).toBe(
      "`.wardby/services.yaml` is invalid: the declared services' instructions exceed the task size limit.",
    );
    const error = serviceRefusal("service_declaration_invalid", SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE);
    expect(serviceRefusalSentence(error)).toBe(SERVICE_INSTRUCTIONS_TOO_LARGE_SENTENCE);
  });

  it("finds no sentence in any other error", () => {
    expect(serviceRefusalSentence("run_tree_exhausted: the run tree's shared budget is spent")).toBeNull();
    expect(serviceRefusalSentence(null)).toBeNull();
    expect(serviceRefusalSentence("service_unknown")).toBeNull();
  });
});

describe("a service that never became ready", () => {
  it("round-trips the service name through the launcher's error", () => {
    expect(serviceUnreadyName(serviceUnreadyError("postgres"))).toBe("postgres");
    expect(serviceUnreadyName(new Error("coding_service_unready:Not A Name"))).toBeNull();
    expect(serviceUnreadyName(new Error("kubernetes_pod_start_timeout"))).toBeNull();
  });

  it("names one service, lists several, and says something useful for none", () => {
    expect(serviceUnreadySentence(["postgres"])).toBe(
      "The `postgres` service didn't become ready, so the run couldn't start.",
    );
    expect(serviceUnreadySentence(["postgres", "redis"])).toBe(
      "One of the run's services (`postgres`, `redis`) didn't become ready, so the run couldn't start.",
    );
    expect(serviceUnreadySentence([])).toBe("A service the run needs didn't become ready, so the run couldn't start.");
  });
});
