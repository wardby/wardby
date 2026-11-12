/** Principal ids referenced as `@[id]` in a comment body. */
export function parseMentions(body: string): string[] {
  return [...body.matchAll(/@\[([A-Za-z0-9_-]{1,64})\]/g)].map((m) => m[1]);
}
