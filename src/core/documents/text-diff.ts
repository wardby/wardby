/**
 * The bounded Myers diff shared by the browser (the Edits tray, src/web/app/diff.ts) and the server
 * (the line-level three-way merge, merge.ts). Pure: no DOM, no Node; the web bundle imports it.
 *
 * Each run is capped at MAX_EDITS edits; past the cap `myers` gives up (null), so time and memory
 * stay bounded on any input.
 */

/** Edits one Myers run may take before it gives up. */
export const MAX_EDITS = 1500;

export type Step = "=" | "-" | "+";

/**
 * The edit script turning `a` into `b` (sequences of interned tokens), or
 * null past `maxEdits`. The trace keeps only each round's live diagonals
 * (2d+1 values), so memory is O(maxEdits²) at worst.
 */
export function myers(a: readonly number[], b: readonly number[], maxEdits = MAX_EDITS): Step[] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(n + m, maxEdits);
  const off = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= limit && found < 0; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  if (found < 0) return null;
  // Walk back through the trace.
  const steps: Step[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1];
    const at = (k: number) => prev[k + d - 1];
    const k = x - y;
    const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = at(pk);
    const py = px - pk;
    while (x > px && y > py) {
      steps.push("=");
      x--;
      y--;
    }
    steps.push(down ? "+" : "-");
    if (down) y--;
    else x--;
  }
  while (x > 0 && y > 0) {
    steps.push("=");
    x--;
    y--;
  }
  return steps.reverse();
}

/** Lines, each with its trailing "\n" (the last may have none): joined, they give back `s`. */
export function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
