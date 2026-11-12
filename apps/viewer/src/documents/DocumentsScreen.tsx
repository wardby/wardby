import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchDocuments, isAppError, openUrl, type AppError, type ServerSummary } from "../api/client";
import type { ListedDocument } from "../api/types";
import { ErrorLine } from "../chrome/ErrorLine";
import { formatEventTime } from "../format/time";

/** Rows asked for; the server caps this at 500. */
export const DOCUMENTS_LIMIT = 500;

const ALL = "";

interface Props {
  server: ServerSummary;
  /** The top bar (with the tabs), rendered above the list. */
  topBar: () => ReactNode;
}

const toError = (e: unknown): AppError =>
  isAppError(e) ? e : { kind: "network", message: e instanceof Error ? e.message : String(e) };

/** `<server origin>/d/<id>`; the server's own page path, never one taken from anywhere else. */
export function documentUrl(serverUrl: string, doc: ListedDocument): string {
  return `${new URL(serverUrl).origin}/d/${encodeURIComponent(doc.id)}`;
}

/** The Documents tab: documents and designs the signed-in admin owns or was granted read access to. */
export function DocumentsScreen({ server, topBar }: Props) {
  const [docs, setDocs] = useState<ListedDocument[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [epoch, setEpoch] = useState(0);
  const [agent, setAgent] = useState(ALL);
  const [repository, setRepository] = useState(ALL);
  const [text, setText] = useState("");
  const [openError, setOpenError] = useState<AppError | null>(null);

  useEffect(() => {
    let active = true;
    fetchDocuments(server.url, DOCUMENTS_LIMIT).then(
      (list) => {
        if (!active) return;
        setDocs(list.documents);
        setTruncated(list.truncated);
        setError(null);
      },
      (e: unknown) => active && setError(toError(e)),
    );
    return () => {
      active = false;
    };
  }, [server.url, epoch]);

  const agents = useMemo(() => {
    const byId = new Map<string, string>();
    for (const d of docs ?? []) if (d.agent) byId.set(d.agent.id, d.agent.name);
    return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [docs]);
  const repositories = useMemo(
    () => [...new Set((docs ?? []).flatMap((d) => (d.repository ? [d.repository] : [])))].sort(),
    [docs],
  );
  const q = text.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (docs ?? []).filter(
        (d) =>
          (agent === ALL || d.agent?.id === agent) &&
          (repository === ALL || d.repository === repository) &&
          (!q || d.title.toLowerCase().includes(q)),
      ),
    [docs, agent, repository, q],
  );

  const open = useCallback(
    (doc: ListedDocument) => {
      setOpenError(null);
      openUrl(documentUrl(server.url, doc)).catch((e: unknown) => setOpenError(toError(e)));
    },
    [server.url],
  );

  return (
    <div className="app">
      {topBar()}
      <main className="main documents">
        <div className="documents-filters">
          <label className="inline">
            <span className="sr-only">Agent</span>
            <select aria-label="Agent" value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value={ALL}>All agents</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            <span className="sr-only">Repository</span>
            <select aria-label="Repository" value={repository} onChange={(e) => setRepository(e.target.value)}>
              <option value={ALL}>All repositories</option>
              {repositories.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </label>
          <input
            type="search"
            aria-label="Search titles"
            placeholder="search titles…"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        {error && (
          <>
            <ErrorLine error={error} />
            <button type="button" onClick={() => setEpoch((n) => n + 1)}>
              Retry
            </button>
          </>
        )}
        {openError && <ErrorLine error={openError} />}
        {!docs && !error && <p className="muted">Loading…</p>}
        {docs && docs.length === 0 && (
          <p className="muted">No documents or designs yet. Ones you own or were granted access to show here.</p>
        )}
        {docs && docs.length > 0 && shown.length === 0 && <p className="muted">No documents match these filters.</p>}
        {shown.length > 0 && (
          <table className="documents-table">
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Kind</th>
                <th scope="col">Agent</th>
                <th scope="col">Repository</th>
                <th scope="col">Updated</th>
                <th scope="col">Version</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((d) => (
                <tr key={d.id} onClick={() => open(d)}>
                  <td>
                    <button type="button" className="link-button" title="Open in the browser">
                      {d.title || "(untitled)"}
                    </button>
                  </td>
                  <td>{d.kind}</td>
                  <td>{d.agent?.name ?? "–"}</td>
                  <td title={d.path ?? undefined}>{d.repository ?? "–"}</td>
                  <td>{formatEventTime(Date.parse(d.updatedAt))}</td>
                  <td>v{d.latestVersion}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {docs && truncated && <p className="muted">Showing the {DOCUMENTS_LIMIT} most recently updated.</p>}
      </main>
    </div>
  );
}
