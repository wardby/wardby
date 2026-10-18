/**
 * The two states a Run can still be driven out of. Every write `executeRun`
 * makes is filtered on these: a durable executor can have two attempts of the
 * same run in flight at once (a still-live original parked in a slow LLM step
 * and an adopted attempt the reconciler resumed elsewhere), and whichever
 * reaches a terminal state first must win. A conditional `updateMany` makes
 * that a database-level CAS rather than a race — the loser's WHERE matches
 * zero rows. It also stops a *later* attempt resurrecting a run the
 * reconciler already reaped: a `lost` row stays `lost`. A step-level
 * ownership loss writes nothing at all (RunOwnershipLostError).
 */
export const DRIVABLE = ["pending", "running"] as const;
