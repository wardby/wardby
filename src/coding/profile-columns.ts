/**
 * The stored CodingAgentProfile columns for a validated coding profile. Shared by every path
 * that writes a profile (create_agent / update_agent and the quickstart seed), so the stored
 * shape cannot drift between them: gitHistory is kept as gitHistoryDepth + gitHistoryFull
 * (full overrides depth), and a missing planDocument is stored as a database NULL.
 */
import { Prisma } from "#prisma";
import type { CodingProfile } from "./profile.js";

export function codingProfileColumns(profile: CodingProfile) {
  const { gitHistory, planDocument, ...rest } = profile;
  return {
    ...rest,
    planDocument: planDocument ?? Prisma.DbNull,
    gitHistoryDepth: gitHistory && gitHistory.depth !== "full" ? gitHistory.depth : null,
    gitHistoryFull: gitHistory?.depth === "full",
  };
}
