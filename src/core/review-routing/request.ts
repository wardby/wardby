/**
 * request_work ranking (#646, spec §5): which routers fit a request written in plain words. No model call: the
 * distinct lower-case words (three letters or more) of the request found in a router's name and description.
 */
export interface RankableRouter {
  id: string;
  name: string;
  description: string | null;
  ownerName: string | null;
}

export interface RankedRouter extends RankableRouter {
  score: number;
}

const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

export function rankRouters(request: string, routers: RankableRouter[], limit = 5): RankedRouter[] {
  const wanted = new Set(words(request).filter((w) => w.length >= 3));
  return routers
    .map((r) => {
      const have = new Set(words(`${r.name} ${r.description ?? ""}`));
      let score = 0;
      for (const w of wanted) if (have.has(w)) score++;
      return { id: r.id, name: r.name, description: r.description, ownerName: r.ownerName, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, limit);
}
