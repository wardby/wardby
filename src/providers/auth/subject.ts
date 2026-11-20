/** Subject prefix of a team's backing principal. No token may carry it (see requireSubject). */
export const TEAM_SUBJECT_PREFIX = "team:";

export function requireSubject(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > 512) {
    throw new Error("Invalid token subject.");
  }
  if (value.startsWith(TEAM_SUBJECT_PREFIX)) {
    throw new Error(`Invalid token subject: the "${TEAM_SUBJECT_PREFIX}" prefix is reserved.`);
  }
  return value;
}
