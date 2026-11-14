import { expect, it } from "vitest";
import {
  AGENT_SUFFIX,
  GATEWAY_AUTHORIZATION_PLACEHOLDER,
  PLACEHOLDER_CAPABILITY,
  RUN_TOKEN_PATTERN,
  TOOL_SUFFIX,
} from "./constants.js";
import {
  agentActorName,
  PLACEHOLDER_CAPABILITY as LAUNCHER_CAPABILITY,
  substrateRunToken,
  toolActorName,
} from "../providers/jobs/substrate/names.js";
import { tarExcludeArgs as bridgeTarExcludeArgs } from "./tar.js";
import { collectExclusions, tarExcludeArgs } from "../coding/collect-exclude.js";

it("matches the launcher's names", () => {
  expect(PLACEHOLDER_CAPABILITY).toBe(LAUNCHER_CAPABILITY);
  const token = substrateRunToken("run-1");
  expect(RUN_TOKEN_PATTERN.test(token)).toBe(true);
  expect(agentActorName(token)).toBe(`${token}${AGENT_SUFFIX}`);
  expect(toolActorName(token)).toBe(`${token}${TOOL_SUFFIX}`);
  expect(GATEWAY_AUTHORIZATION_PLACEHOLDER).toBe("placeholder");
});

it("renders collect exclusions as the repository does", () => {
  const exclusions = collectExclusions(["web/dist"]);
  expect(bridgeTarExcludeArgs(exclusions)).toEqual(tarExcludeArgs(exclusions));
});
