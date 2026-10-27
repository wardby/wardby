// TEST ONLY (wardby-sim). A small JQL subset for /rest/api/3/search/jql: AND / OR / NOT,
// parentheses, `=`, `!=`, `~`, `in`, `not in`, `is EMPTY`, `is not EMPTY`, over the fields
// key/issuekey, project, labels, status, statusCategory, assignee, reporter, issuetype, summary
// and parent; a trailing ORDER BY is ignored. Anything else is a 400, as Jira answers an
// unknown field. Values compare case-insensitively.
import type { JiraIssue, JiraState } from "./state.js";

export class JqlError extends Error {}

type Token = { kind: "word" | "string" | "op" | "lparen" | "rparen" | "comma"; value: string };

function tokenize(jql: string): Token[] {
  const tokens: Token[] = [];
  const re = /\s*(?:(\()|(\))|(,)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(!=|=|~|!~)|([^\s(),=!~"']+))/gy;
  let match: RegExpExecArray | null;
  let at = 0;
  while (at < jql.length && (match = re.exec(jql))) {
    at = re.lastIndex;
    if (match[1]) tokens.push({ kind: "lparen", value: "(" });
    else if (match[2]) tokens.push({ kind: "rparen", value: ")" });
    else if (match[3]) tokens.push({ kind: "comma", value: "," });
    else if (match[4]) tokens.push({ kind: "string", value: match[4].slice(1, -1).replace(/\\(.)/g, "$1") });
    else if (match[5]) tokens.push({ kind: "op", value: match[5] });
    else if (match[6]) tokens.push({ kind: "word", value: match[6] });
  }
  if (jql.slice(at).trim() !== "")
    throw new JqlError(`Error in the JQL Query: unexpected '${jql.slice(at, at + 10)}'.`);
  return tokens;
}

type Pred = (issue: JiraIssue) => boolean;

export function compileJql(jql: string, state: JiraState): Pred {
  const withoutOrder = jql.replace(/\border\s+by\b[\s\S]*$/i, "").trim();
  if (withoutOrder === "") return () => true;
  const tokens = tokenize(withoutOrder);
  let i = 0;
  const peek = () => tokens[i];
  const isWord = (t: Token | undefined, w: string) => t?.kind === "word" && t.value.toLowerCase() === w;

  const values = (issue: JiraIssue, field: string): string[] => {
    switch (field) {
      case "key":
      case "issuekey":
      case "issue":
        return [issue.key, issue.id];
      case "project":
        return [issue.projectKey, state.project(issue).id, state.project(issue).name];
      case "labels":
        return issue.labels;
      case "status":
        return [state.status(issue).name, state.status(issue).id];
      case "statuscategory":
        return [{ new: "To Do", indeterminate: "In Progress", done: "Done" }[state.status(issue).category] ?? ""];
      case "assignee":
        return issue.assignee ? [issue.assignee] : [];
      case "reporter":
        return [issue.reporter];
      case "issuetype":
      case "type":
        return [issue.issueType.name];
      case "summary":
      case "text":
        return [issue.summary];
      case "parent":
        return issue.parentKey ? [issue.parentKey] : [];
      default:
        throw new JqlError(`Field '${field}' does not exist or you do not have permission to view it.`);
    }
  };

  const value = (): string => {
    const t = tokens[i++];
    if (!t || (t.kind !== "word" && t.kind !== "string"))
      throw new JqlError("Error in the JQL Query: expected a value.");
    return t.value;
  };

  const clause = (): Pred => {
    const fieldToken = tokens[i++];
    if (!fieldToken || (fieldToken.kind !== "word" && fieldToken.kind !== "string"))
      throw new JqlError("Error in the JQL Query: expected a field.");
    const field = fieldToken.value.toLowerCase();
    if (!KNOWN_FIELDS.has(field))
      throw new JqlError(`Field '${fieldToken.value}' does not exist or you do not have permission to view it.`);
    const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    const t = peek();
    if (t?.kind === "op") {
      i++;
      const v = value();
      if (t.value === "=") return (issue) => values(issue, field).some((x) => eq(x, v));
      if (t.value === "!=") return (issue) => !values(issue, field).some((x) => eq(x, v));
      if (t.value === "~")
        return (issue) => values(issue, field).some((x) => x.toLowerCase().includes(v.toLowerCase()));
      return (issue) => !values(issue, field).some((x) => x.toLowerCase().includes(v.toLowerCase()));
    }
    const not = isWord(t, "not");
    if (not) i++;
    if (isWord(peek(), "in")) {
      i++;
      if (peek()?.kind !== "lparen") throw new JqlError("Error in the JQL Query: expected '('.");
      i++;
      const list: string[] = [];
      while (peek() && peek().kind !== "rparen") {
        list.push(value());
        if (peek()?.kind === "comma") i++;
      }
      i++;
      const hit = (issue: JiraIssue) => values(issue, field).some((x) => list.some((v) => eq(x, v)));
      return not ? (issue) => !hit(issue) : hit;
    }
    if (!not && isWord(peek(), "is")) {
      i++;
      const negate = isWord(peek(), "not");
      if (negate) i++;
      const v = value().toLowerCase();
      if (v !== "empty" && v !== "null") throw new JqlError("Error in the JQL Query: expected EMPTY.");
      return (issue) => (values(issue, field).length === 0) !== negate;
    }
    throw new JqlError(`Error in the JQL Query: expected an operator after '${fieldToken.value}'.`);
  };

  const factor = (): Pred => {
    if (isWord(peek(), "not")) {
      i++;
      const inner = factor();
      return (issue) => !inner(issue);
    }
    if (peek()?.kind === "lparen") {
      i++;
      const inner = expr();
      if (peek()?.kind !== "rparen") throw new JqlError("Error in the JQL Query: expected ')'.");
      i++;
      return inner;
    }
    return clause();
  };
  const term = (): Pred => {
    let left = factor();
    while (isWord(peek(), "and")) {
      i++;
      const l = left;
      const r = factor();
      left = (issue) => l(issue) && r(issue);
    }
    return left;
  };
  const expr = (): Pred => {
    let left = term();
    while (isWord(peek(), "or")) {
      i++;
      const l = left;
      const r = term();
      left = (issue) => l(issue) || r(issue);
    }
    return left;
  };
  const pred = expr();
  if (i !== tokens.length) throw new JqlError("Error in the JQL Query: unexpected input at the end.");
  return pred;
}

const KNOWN_FIELDS = new Set([
  "key",
  "issuekey",
  "issue",
  "project",
  "labels",
  "status",
  "statuscategory",
  "assignee",
  "reporter",
  "issuetype",
  "type",
  "summary",
  "text",
  "parent",
]);
