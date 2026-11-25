import type { HelpCatalog, HelpPage } from "./catalog.js";
import { loadBundledHelpCatalog } from "./runtime.js";
import { findHelpPage, searchHelp } from "./search.js";

function helpUsage(): string {
  return `usage:
  wardby help list
  wardby help search <terms>
  wardby help open <article-id>

Search is offline and fuzzy across titles, tags, headings, summaries, and article text.`;
}

function print(message: string): void {
  process.stdout.write(`${message}\n`);
}

function printPage(page: HelpPage): void {
  print(page.markdown.trim());
}

function printList(catalog: HelpCatalog): void {
  print(`Wardby help (${catalog.pages.length} articles)`);
  for (const page of catalog.pages) {
    print(`\n${page.id}\n  ${page.title} — ${page.summary}`);
  }
  print("\nUse `wardby help search <terms>` to find an article, then `wardby help open <article-id>` to read it.");
}

function printResults(catalog: HelpCatalog, query: string): void {
  const results = searchHelp(catalog, query);
  if (!results.length) {
    print(`No help articles matched "${query}".`);
    return;
  }

  print(`Help results for "${query}":`);
  for (const result of results.slice(0, 10)) {
    print(`\n${result.page.title} (${result.page.id})`);
    if (result.matchedHeading && result.matchedHeading.text !== result.page.title) {
      print(`  Match: ${result.matchedHeading.text}`);
    }
    print(`  ${result.excerpt}`);
  }
}

/** Runs the dependency-free, bundled help command. */
export async function helpCommand(args: string[]): Promise<void> {
  const catalog = await loadBundledHelpCatalog();
  const [operation, ...rest] = args;

  if (!operation || operation === "list") {
    printList(catalog);
    return;
  }
  if (operation === "search") {
    const query = rest.join(" ").trim();
    if (!query) throw new Error("help search requires one or more terms.\n\n" + helpUsage());
    printResults(catalog, query);
    return;
  }
  if (operation === "open") {
    const id = rest[0];
    if (!id || rest.length !== 1) throw new Error("help open requires exactly one article id.\n\n" + helpUsage());
    const page = findHelpPage(catalog, id);
    if (!page) throw new Error(`unknown help article "${id}". Run \`wardby help list\` to see available articles.`);
    printPage(page);
    return;
  }

  throw new Error(`unknown help command "${operation}".\n\n${helpUsage()}`);
}
