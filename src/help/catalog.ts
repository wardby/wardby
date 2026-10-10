import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import semver from "semver";

export type HelpAudience = "operator" | "developer" | "all";

export interface HelpHeading {
  level: number;
  text: string;
  slug: string;
}

export interface HelpPage {
  id: string;
  title: string;
  summary: string;
  audience: HelpAudience;
  tags: string[];
  appliesTo: string;
  sourcePath: string;
  markdown: string;
  plainText: string;
  headings: HelpHeading[];
}

export interface HelpCatalog {
  schemaVersion: 1;
  pages: HelpPage[];
}

interface ParsedPage {
  page: HelpPage;
  filePath: string;
}

const REQUIRED_FIELDS = ["id", "title", "summary", "audience", "tags", "appliesTo"] as const;
const ALLOWED_FIELDS = new Set<string>(REQUIRED_FIELDS);
const MARKDOWN_LINK = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;

function failure(sourcePath: string, message: string): Error {
  return new Error(`Invalid help page ${sourcePath}: ${message}`);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[^\n]*\n?|```/g, ""))
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/^\s{0,3}\d+\.\s+/gm, "")
    .replace(/[>*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseFrontmatter(sourcePath: string, markdown: string): { fields: Map<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
  if (!match) throw failure(sourcePath, "expected YAML frontmatter delimited by ---");

  const fields = new Map<string, string>();
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9]*):\s*(.+)$/.exec(line);
    if (!field) throw failure(sourcePath, `unsupported frontmatter line: ${line}`);
    const [, key, value] = field;
    if (!ALLOWED_FIELDS.has(key)) throw failure(sourcePath, `unknown frontmatter field "${key}"`);
    if (fields.has(key)) throw failure(sourcePath, `duplicate frontmatter field "${key}"`);
    fields.set(key, value.trim());
  }

  for (const required of REQUIRED_FIELDS) {
    if (!fields.get(required)) throw failure(sourcePath, `missing frontmatter field "${required}"`);
  }
  return { fields, body: match[2] };
}

function parseTags(sourcePath: string, value: string): string[] {
  const match = /^\[([^\]]*)\]$/.exec(value);
  if (!match) throw failure(sourcePath, "tags must be an inline list, for example [budget, security]");
  const tags = match[1]
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (!tags.length) throw failure(sourcePath, "tags must contain at least one value");
  if (new Set(tags).size !== tags.length) throw failure(sourcePath, "tags must not contain duplicates");
  return tags;
}

function parseAppliesTo(sourcePath: string, raw: string): string {
  const value = raw.replace(/^"(.*)"$/, "$1");
  const minimum = /^>=(\d+\.\d+\.\d+)$/.exec(value)?.[1];
  if (!minimum || !semver.valid(minimum)) {
    throw failure(sourcePath, 'appliesTo must be a minimum release, for example ">=0.5.3"');
  }
  return value;
}

function headings(markdown: string): HelpHeading[] {
  return [...markdown.matchAll(/^(#{1,6})\s+(.+?)\s*#*\s*$/gm)].map((match) => ({
    level: match[1].length,
    text: match[2].trim(),
    slug: slugify(match[2]),
  }));
}

function parsePage(root: string, filePath: string, markdown: string): ParsedPage {
  const sourcePath = relative(root, filePath).split(sep).join("/");
  const { fields, body } = parseFrontmatter(sourcePath, markdown);
  const audience = fields.get("audience")!;
  if (audience !== "operator" && audience !== "developer" && audience !== "all") {
    throw failure(sourcePath, 'audience must be "operator", "developer", or "all"');
  }

  const pageHeadings = headings(body);
  return {
    filePath,
    page: {
      id: fields.get("id")!,
      title: fields.get("title")!,
      summary: fields.get("summary")!,
      audience,
      tags: parseTags(sourcePath, fields.get("tags")!),
      appliesTo: parseAppliesTo(sourcePath, fields.get("appliesTo")!),
      sourcePath,
      markdown: body,
      plainText: plainText(body),
      headings: pageHeadings,
    },
  };
}

async function markdownFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    else if (entry.isSymbolicLink()) throw new Error(`Help corpus must not contain symbolic links: ${path}`);
  }
  return files;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function validateLinks(root: string, pages: ParsedPage[], releaseVersion?: string): void {
  const byId = new Map(pages.map(({ page }) => [page.id, page]));
  const byFile = new Map(pages.map((parsed) => [resolve(parsed.filePath), parsed.page]));
  const included = (page: HelpPage) => !releaseVersion || semver.satisfies(releaseVersion, page.appliesTo);

  for (const { page, filePath } of pages) {
    for (const match of page.markdown.matchAll(MARKDOWN_LINK)) {
      const href = match[1];
      if (href.startsWith("help://")) {
        const id = href.slice("help://".length).split("#", 1)[0];
        const linkedPage = byId.get(id);
        if (!linkedPage) throw failure(page.sourcePath, `unknown help link "${href}"`);
        if (included(page) && !included(linkedPage)) {
          throw failure(
            page.sourcePath,
            `help link "${href}" requires ${linkedPage.appliesTo}, after release ${releaseVersion}`,
          );
        }
        continue;
      }

      const [target, fragment] = href.split("#", 2);
      let linkedPage = page;
      if (target.endsWith(".md")) {
        const linkedPath = resolve(filePath, "..", target);
        if (!isWithin(root, linkedPath)) continue;
        linkedPage = byFile.get(linkedPath)!;
        if (!linkedPage) throw failure(page.sourcePath, `unknown help link "${href}"`);
      } else if (target) {
        continue;
      }

      if (included(page) && !included(linkedPage)) {
        throw failure(
          page.sourcePath,
          `help link "${href}" requires ${linkedPage.appliesTo}, after release ${releaseVersion}`,
        );
      }

      if (fragment && !linkedPage.headings.some((heading) => heading.slug === decodeURIComponent(fragment))) {
        throw failure(page.sourcePath, `unknown help heading "${href}"`);
      }
    }
  }
}

/** Builds the deterministic, release-bundled catalog from the checked-in help corpus. */
export async function buildHelpCatalog(root: string, releaseVersion?: string): Promise<HelpCatalog> {
  if (releaseVersion && !semver.valid(releaseVersion)) {
    throw new Error(`Invalid help release version "${releaseVersion}"`);
  }
  const canonicalRoot = resolve(root);
  const files = await markdownFiles(canonicalRoot);
  if (!files.length) throw new Error(`Help corpus has no Markdown pages: ${canonicalRoot}`);

  const pages = await Promise.all(
    files.map(async (filePath) => parsePage(canonicalRoot, filePath, await readFile(filePath, "utf8"))),
  );
  pages.sort((a, b) => a.page.id.localeCompare(b.page.id));

  for (const [index, current] of pages.entries()) {
    if (index > 0 && current.page.id === pages[index - 1].page.id) {
      throw failure(current.page.sourcePath, `duplicate page id "${current.page.id}"`);
    }
  }
  validateLinks(canonicalRoot, pages, releaseVersion);

  return {
    schemaVersion: 1,
    pages: pages
      .map(({ page }) => page)
      .filter((page) => !releaseVersion || semver.satisfies(releaseVersion, page.appliesTo)),
  };
}
