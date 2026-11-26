/**
 * Word-level three-way merge of a text box's HTML (tags count as words). The server merges an agent's version into a
 * box someone changed meanwhile with it, and the page merges a person's typing into a box someone else changed
 * meanwhile. No imports: the browser bundle uses it too.
 */
/**
 * Word-level three-way merge: both sides' changes to `base`; where they overlap, `theirs` wins. Words both added at
 * the same point are both kept (`mine`'s first).
 */
export function merge3(base: string, mine: string, theirs: string): string {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  // Tags and words are tokens; whitespace is one token per character, so typing after a run of whitespace (a box
  // ending in a newline and indentation) is an insertion after it, not a change to it.
  const tok = (x: string) => x.match(/<[^>]+>|[^<\s]+|\s/g) ?? [];
  const [b, m, t] = [tok(base), tok(mine), tok(theirs)];
  type Hunk = { a0: number; a1: number; with: string[]; from: "m" | "t" };
  const hunks = (x: string[], from: "m" | "t"): Hunk[] => {
    const dp = Array.from({ length: b.length + 1 }, () => new Array<number>(x.length + 1).fill(0));
    for (let i = b.length - 1; i >= 0; i--)
      for (let j = x.length - 1; j >= 0; j--)
        dp[i][j] = b[i] === x[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out: Hunk[] = [];
    let i = 0;
    let j = 0;
    while (i < b.length || j < x.length) {
      if (i < b.length && j < x.length && b[i] === x[j]) {
        i++;
        j++;
        continue;
      }
      const h: Hunk = { a0: i, a1: i, with: [], from };
      while ((i < b.length || j < x.length) && !(i < b.length && j < x.length && b[i] === x[j])) {
        if (j < x.length && (i >= b.length || dp[i][j + 1] >= dp[i + 1][j])) h.with.push(x[j++]);
        else i++;
      }
      h.a1 = i;
      out.push(h);
    }
    return out;
  };
  const ht = hunks(t, "t");
  // Two insertions at the same point (both added words there, neither removed any) do not overlap: both stay,
  // `mine` first. Anything else at the same point does.
  const bothInsert = (x: Hunk, y: Hunk) => x.a0 === x.a1 && y.a0 === y.a1;
  const overlaps = (x: Hunk, y: Hunk) =>
    (x.a0 < y.a1 && y.a0 < x.a1) ||
    (x.a0 === y.a0 && !bothInsert(x, y)) ||
    (x.a0 === x.a1 && x.a0 > y.a0 && x.a0 < y.a1) ||
    (y.a0 === y.a1 && y.a0 > x.a0 && y.a0 < x.a1);
  const hm = hunks(m, "m").filter((h) => !ht.some((x) => overlaps(h, x)));
  const all = [...ht, ...hm].sort((x, y) => x.a0 - y.a0 || (x.from === "m" ? -1 : 1));
  let out = "";
  let pos = 0;
  for (const h of all) {
    out += b.slice(pos, h.a0).join("") + h.with.join("");
    pos = Math.max(pos, h.a1);
  }
  return out + b.slice(pos).join("");
}
