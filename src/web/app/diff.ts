/**
 * A small text diff for the Edits tray: what changed between two versions'
 * plain text (the anchoring form, anchors.ts), at word level.
 *
 * Myers' O(ND) algorithm, run twice: first over lines (a long document with a
 * few edits stays cheap), then over word tokens inside each changed run of
 * lines. Each run is capped at MAX_EDITS edits; past the cap that run is shown
 * as replaced as a whole, so time and memory stay bounded on any input.
 * No DOM here.
 */

export type DiffOp = { kind: "equal" | "insert" | "delete"; text: string };

/** Edits one Myers run may take before it gives up and reports the run as replaced. */
export const MAX_EDITS = 1500;

type Step = "=" | "-" | "+";

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

/** Lines, each with its trailing "\n" (the last may have none). */
export function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Words, runs of spaces, single newlines and single punctuation marks: joined, they give back `s`. */
export function splitWords(s: string): string[] {
  return s.match(/\n|[^\S\n]+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) ?? [];
}

function push(out: DiffOp[], kind: DiffOp["kind"], text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) last.text += text;
  else out.push({ kind, text });
}

/** Token-level diff of two token lists; a run past the cap is reported as one delete and one insert. */
function diffTokens(a: string[], b: string[], out: DiffOp[], onReplace?: (a: string, b: string) => void): void {
  const ids = new Map<string, number>();
  const intern = (t: string) => {
    let id = ids.get(t);
    if (id === undefined) ids.set(t, (id = ids.size));
    return id;
  };
  // Common prefix and suffix first: most edits are local.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  push(out, "equal", a.slice(0, start).join(""));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const steps = myers(midA.map(intern), midB.map(intern));
  if (!steps) {
    if (onReplace) onReplace(midA.join(""), midB.join(""));
    else {
      push(out, "delete", midA.join(""));
      push(out, "insert", midB.join(""));
    }
  } else {
    let i = 0;
    let j = 0;
    let delRun = "";
    let insRun = "";
    const flush = () => {
      if (delRun && insRun && onReplace) onReplace(delRun, insRun);
      else {
        push(out, "delete", delRun);
        push(out, "insert", insRun);
      }
      delRun = "";
      insRun = "";
    };
    for (const s of steps) {
      if (s === "=") {
        flush();
        push(out, "equal", midA[i]);
        i++;
        j++;
      } else if (s === "-") delRun += midA[i++];
      else insRun += midB[j++];
    }
    flush();
  }
  push(out, "equal", a.slice(endA).join(""));
}

/**
 * The word-level difference from `before` to `after`: equal and delete parts
 * concatenate to `before`, equal and insert parts to `after`.
 */
export function diffText(before: string, after: string): DiffOp[] {
  const out: DiffOp[] = [];
  diffTokens(splitLines(before), splitLines(after), out, (a, b) => diffTokens(splitWords(a), splitWords(b), out));
  return mergeShortGaps(out);
}

/**
 * Readability: changes separated only by spaces (no newline) become one
 * delete and one insert ("the team channel" → "#launch on Slack" reads as one
 * replacement, not three interleaved ones).
 */
export function mergeShortGaps(ops: DiffOp[]): DiffOp[] {
  const out: DiffOp[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].kind === "equal") {
      out.push({ ...ops[i] });
      i++;
      continue;
    }
    // A run of changes, absorbing space-only equal gaps between them.
    let del = "";
    let ins = "";
    let j = i;
    while (j < ops.length) {
      const op = ops[j];
      if (op.kind === "delete") del += op.text;
      else if (op.kind === "insert") ins += op.text;
      else if (/^[^\S\n]+$/.test(op.text) && j + 1 < ops.length && ops[j + 1].kind !== "equal") {
        del += op.text;
        ins += op.text;
      } else break;
      j++;
    }
    push(out, "delete", del);
    push(out, "insert", ins);
    i = j;
  }
  return out;
}
