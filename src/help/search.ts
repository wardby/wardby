import type { HelpCatalog, HelpHeading, HelpPage } from "./catalog.js";

export interface HelpSearchResult {
  page: HelpPage;
  score: number;
  matchedHeading?: HelpHeading;
  excerpt: string;
}

interface SearchField {
  text: string;
  weight: number;
}

const WORD = /[a-z0-9]+/g;

function words(value: string): string[] {
  return value.toLowerCase().match(WORD) ?? [];
}

function damerauLevenshtein(left: string, right: string): number {
  const previousPrevious = new Array<number>(right.length + 1).fill(0);
  let previous = new Array<number>(right.length + 1).fill(0);
  let current = new Array<number>(right.length + 1).fill(0);

  for (let column = 0; column <= right.length; column += 1) previous[column] = column;

  for (let row = 1; row <= left.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const substitution = previous[column - 1] + Number(left[row - 1] !== right[column - 1]);
      const insertion = current[column - 1] + 1;
      const deletion = previous[column] + 1;
      let distance = Math.min(substitution, insertion, deletion);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        distance = Math.min(distance, previousPrevious[column - 2] + 1);
      }
      current[column] = distance;
    }
    previousPrevious.splice(0, previousPrevious.length, ...previous);
    [previous, current] = [current, previous];
  }
  return previous[right.length];
}

function wordScore(query: string, candidate: string): number {
  if (query === candidate) return 1;
  if (query.length >= 2 && candidate.startsWith(query)) return 0.9;
  if (query.length >= 3 && candidate.includes(query)) return 0.75;

  // Short words are too broad for typo matching. Longer terms accept a small,
  // bounded edit distance, including a swapped adjacent character.
  if (query.length < 4 || candidate.length < 4) return 0;
  const maximumDistance = query.length <= 5 ? 1 : query.length <= 8 ? 2 : 3;
  const distance = damerauLevenshtein(query, candidate);
  if (distance > maximumDistance) return 0;
  return 0.6 - (distance - 1) * 0.1;
}

function fieldScore(query: string, field: SearchField): number {
  let best = 0;
  for (const candidate of words(field.text)) best = Math.max(best, wordScore(query, candidate));
  return best * field.weight;
}

function pageScore(queries: string[], page: HelpPage): number | undefined {
  const fields: SearchField[] = [
    { text: page.title, weight: 12 },
    { text: page.tags.join(" "), weight: 10 },
    { text: page.summary, weight: 5 },
    ...page.headings.map((heading) => ({ text: heading.text, weight: 8 })),
    { text: page.plainText, weight: 1 },
  ];

  let total = 0;
  for (const query of queries) {
    const score = Math.max(...fields.map((field) => fieldScore(query, field)));
    if (score === 0) return undefined;
    total += score;
  }
  return total;
}

function matchingHeading(queries: string[], page: HelpPage): HelpHeading | undefined {
  return page.headings
    .map((heading) => ({
      heading,
      score: queries.reduce((total, query) => total + fieldScore(query, { text: heading.text, weight: 1 }), 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.heading.slug.localeCompare(right.heading.slug))[0]?.heading;
}

function truncate(value: string, length = 180): string {
  return value.length <= length ? value : `${value.slice(0, length - 1).trimEnd()}…`;
}

function excerpt(queries: string[], page: HelpPage): string {
  const candidates = [page.summary, ...page.plainText.split(/(?<=[.!?])\s+/)].filter(Boolean);
  const best = candidates
    .map((candidate) => ({
      candidate,
      score: queries.reduce((total, query) => total + fieldScore(query, { text: candidate, weight: 1 }), 0),
    }))
    .sort((left, right) => right.score - left.score || left.candidate.length - right.candidate.length)[0];
  return truncate(best?.candidate ?? page.summary);
}

/** Finds pages with deterministic, offline fuzzy matching over their catalog metadata and body. */
export function searchHelp(catalog: HelpCatalog, query: string): HelpSearchResult[] {
  const queries = words(query);
  if (!queries.length) return [];

  const results: HelpSearchResult[] = [];
  for (const page of catalog.pages) {
    const score = pageScore(queries, page);
    if (score === undefined) continue;
    const heading = matchingHeading(queries, page);
    results.push({ page, score, ...(heading ? { matchedHeading: heading } : {}), excerpt: excerpt(queries, page) });
  }
  // On a tie, a guide outranks an error article: error codes in titles share words (like "mcp") with their guide.
  const isError = (result: HelpSearchResult): number => Number(result.page.id.startsWith("errors/"));
  return results.sort(
    (left, right) =>
      right.score - left.score || isError(left) - isError(right) || left.page.id.localeCompare(right.page.id),
  );
}
