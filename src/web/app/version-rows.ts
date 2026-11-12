/**
 * The version list's pure parts, shared by the Edits tray (history.ts) and the design page's History
 * tab: grouping versions into rows and the row text. No DOM, and nothing that needs Tiptap.
 */

/** One version as GET /d/api/<id>/versions lists it. */
export interface VersionItem {
  number: number;
  via: string;
  createdAt: string;
  author: { kind: "member" | "agent"; name: string; viaName?: string };
  /** Opaque per-document key of the saving member; absent when unknown. Grouping uses it, never the name. */
  authorKey?: string;
  runId?: string;
  summary?: string;
  answeredThreads: number[];
}

/** One tray row: one version, or several editor saves grouped (newest first). */
export interface EditRow {
  /** Oldest and newest version numbers in the row. */
  first: number;
  last: number;
  items: VersionItem[];
}

/** Editor saves by the same person, each within this long of the one before, share a row. */
export const GROUP_WINDOW_MS = 5 * 60 * 1000;

const RESTORED = /^Restored v(\d+)$/;

/** The version a restore copied, or null when it is not a restore. */
export function restoredFrom(v: VersionItem): number | null {
  const m = v.summary ? RESTORED.exec(v.summary) : null;
  return m ? Number(m[1]) : null;
}

const groupable = (v: VersionItem) => v.via === "editor" && v.author.kind === "member" && restoredFrom(v) === null;

/** Groups versions (newest first) into rows; agent, MCP, import and restore versions always stand alone. */
export function groupVersions(versions: readonly VersionItem[], windowMs = GROUP_WINDOW_MS): EditRow[] {
  const rows: EditRow[] = [];
  for (const v of versions) {
    const row = rows[rows.length - 1];
    const oldest = row?.items[row.items.length - 1];
    if (
      row &&
      oldest &&
      groupable(v) &&
      groupable(oldest) &&
      oldest.number === v.number + 1 &&
      v.authorKey !== undefined &&
      oldest.authorKey === v.authorKey &&
      Date.parse(oldest.createdAt) - Date.parse(v.createdAt) <= windowMs
    ) {
      row.items.push(v);
      row.first = v.number;
      continue;
    }
    rows.push({ first: v.number, last: v.number, items: [v] });
  }
  return rows;
}

const VIA_SUFFIX: Record<string, string> = { mcp: " (MCP)", import: " (import)" };

/** The row's version label and text parts, e.g. "v4–v5" and ["Chris Fields", "2 edits"]. */
export function describeRow(row: EditRow): { versions: string; parts: string[] } {
  const versions = row.first === row.last ? `v${row.last}` : `v${row.first}–v${row.last}`;
  const v = row.items[0];
  const who = v.author.name + (VIA_SUFFIX[v.via] ?? "");
  const restored = restoredFrom(v);
  if (restored !== null) return { versions, parts: [`Restored v${restored}`, who] };
  if (v.author.kind === "agent") {
    return { versions, parts: ["Agent", ...(v.author.viaName ? [`via ${v.author.viaName}`] : [])] };
  }
  if (row.first === 1 && row.items.length === 1) return { versions, parts: [`Created by ${who}`] };
  return { versions, parts: [who, ...(row.items.length > 1 ? [`${row.items.length} edits`] : [])] };
}

/** "just now", "2 min ago", "3 h ago", "4 d ago", or the date. */
export function ago(iso: string, now: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toISOString().slice(0, 10);
}
