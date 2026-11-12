import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DocumentList } from "../api/types";

const api = vi.hoisted(() => ({ fetchDocuments: vi.fn(), openUrl: vi.fn() }));
vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), ...api }));

import { DocumentsScreen } from "./DocumentsScreen";

const server = { name: "S", url: "https://w.example/mcp", signed_in: true, kube_context: null };
const row = (over: Partial<DocumentList["documents"][number]> & { id: string }): DocumentList["documents"][number] => ({
  title: "T",
  kind: "document",
  mine: true,
  agent: null,
  repository: null,
  path: null,
  updatedAt: "2026-11-01T10:00:00.000Z",
  latestVersion: 2,
  pagePath: `/d/${over.id}`,
  ...over,
});
const LIST: DocumentList = {
  truncated: false,
  documents: [
    row({
      id: "d1",
      title: "Plan",
      agent: { id: "a1", name: "planner" },
      repository: "acme/one",
      path: "docs/plan.md",
    }),
    row({
      id: "d2",
      title: "Coffee shop",
      kind: "design",
      agent: { id: "a2", name: "designer" },
      repository: "acme/two",
    }),
    row({ id: "d3", title: "<img src=x onerror=alert(1)>" }),
  ],
};

const renderScreen = () => render(<DocumentsScreen server={server} topBar={() => <div>bar</div>} />);

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchDocuments.mockResolvedValue(LIST);
  api.openUrl.mockResolvedValue(undefined);
});

describe("DocumentsScreen", () => {
  it("lists the rows and asks the server for them", async () => {
    renderScreen();
    expect(await screen.findByText("Plan")).toBeInTheDocument();
    expect(api.fetchDocuments).toHaveBeenCalledWith(server.url, 500);
    const plan = screen.getByText("Plan").closest("tr")!;
    expect(within(plan).getByText("planner")).toBeInTheDocument();
    expect(within(plan).getByText("acme/one")).toBeInTheDocument();
    expect(within(plan).getByText("v2")).toBeInTheDocument();
    expect(within(screen.getByText("Coffee shop").closest("tr")!).getByText("design")).toBeInTheDocument();
  });

  it("renders a title as text, never as HTML", async () => {
    const { container } = renderScreen();
    expect(await screen.findByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("narrows by agent, repository and title text", async () => {
    renderScreen();
    await screen.findByText("Plan");
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "a2" } });
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.getByText("Coffee shop")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Agent"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "acme/one" } });
    expect(screen.getByText("Plan")).toBeInTheDocument();
    expect(screen.queryByText("Coffee shop")).toBeNull();
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Search titles"), { target: { value: "coffee" } });
    expect(screen.queryByText("Plan")).toBeNull();
    expect(screen.getByText("Coffee shop")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search titles"), { target: { value: "zzz" } });
    expect(screen.getByText("No documents match these filters.")).toBeInTheDocument();
  });

  it("opens /d/<id> on the server origin when a row is clicked", async () => {
    renderScreen();
    fireEvent.click((await screen.findByText("Coffee shop")).closest("tr")!);
    expect(api.openUrl).toHaveBeenCalledTimes(1);
    expect(api.openUrl).toHaveBeenCalledWith("https://w.example/d/d2");
  });

  it("shows an empty state", async () => {
    api.fetchDocuments.mockResolvedValue({ documents: [], truncated: false });
    renderScreen();
    expect(await screen.findByText(/No documents or designs yet/)).toBeInTheDocument();
  });

  it("shows the error and retries", async () => {
    api.fetchDocuments.mockRejectedValueOnce({ kind: "forbidden", message: "needs admin" });
    renderScreen();
    expect(await screen.findByRole("alert")).toHaveTextContent("needs admin");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Plan")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("says when the list is cut short", async () => {
    api.fetchDocuments.mockResolvedValue({ ...LIST, truncated: true });
    renderScreen();
    expect(await screen.findByText(/most recently updated/)).toBeInTheDocument();
  });
});
