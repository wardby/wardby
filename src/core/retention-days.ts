/**
 * Reads a retention setting in whole days (1 to 3650) from the environment. An unset or blank value
 * gives `defaultDays`; anything else out of range stops start-up, naming the variable.
 */
export function loadRetentionDays(env: NodeJS.ProcessEnv, name: string, defaultDays: number): number {
  const raw = env[name]?.trim();
  if (!raw) return defaultDays;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new Error(`${name} must be a whole number of days from 1 to 3650.`);
  }
  return days;
}
