import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  addServer,
  cancelSignIn,
  connect,
  disconnect,
  fetchGraph,
  fetchDocuments,
  fetchInfra,
  fetchRun,
  isAppError,
  kubeContexts,
  listServers,
  onFrame,
  openUrl,
  removeServer,
  setKubeContext,
  signIn,
  signOut,
  type FramePayload,
} from "./client";

const invokeMock = vi.mocked(invoke);
const listenMock = vi.mocked(listen);

beforeEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
  invokeMock.mockResolvedValue(undefined);
});

describe("command wrappers", () => {
  it("pass the right command names and arguments", async () => {
    await listServers();
    await addServer("Prod", "https://w.example", "cid");
    await addServer("Dev", "https://d.example");
    await removeServer("https://w.example");
    await signIn("https://w.example");
    await cancelSignIn("https://w.example");
    await signOut("https://w.example");
    await connect("https://w.example");
    await disconnect("https://w.example");
    await fetchGraph("https://w.example", "24h", 200);
    await fetchRun("https://w.example", "run-1");
    await openUrl("https://github.com/o/r/pull/7");
    await fetchInfra("https://w.example");
    await fetchDocuments("https://w.example", 500);
    await kubeContexts();
    await setKubeContext("https://w.example", "kind-dev");
    await setKubeContext("https://w.example", null);
    expect(invokeMock.mock.calls).toEqual([
      ["list_servers"],
      ["add_server", { name: "Prod", url: "https://w.example", clientId: "cid" }],
      ["add_server", { name: "Dev", url: "https://d.example", clientId: null }],
      ["remove_server", { url: "https://w.example" }],
      ["sign_in", { url: "https://w.example" }],
      ["cancel_sign_in", { url: "https://w.example" }],
      ["sign_out", { url: "https://w.example" }],
      ["connect", { url: "https://w.example" }],
      ["disconnect", { url: "https://w.example" }],
      ["fetch_graph", { url: "https://w.example", since: "24h", limit: 200 }],
      ["fetch_run", { url: "https://w.example", id: "run-1" }],
      ["open_url", { url: "https://github.com/o/r/pull/7" }],
      ["fetch_infra", { url: "https://w.example" }],
      ["fetch_documents", { url: "https://w.example", limit: 500 }],
      ["kube_contexts"],
      ["set_kube_context", { url: "https://w.example", context: "kind-dev" }],
      ["set_kube_context", { url: "https://w.example", context: null }],
    ]);
  });

  it("returns what the command returns and passes rejections through", async () => {
    invokeMock.mockResolvedValueOnce([{ name: "a", url: "https://a", signed_in: true, kube_context: null }]);
    expect(await listServers()).toEqual([{ name: "a", url: "https://a", signed_in: true, kube_context: null }]);
    const err = { kind: "forbidden", message: "no" };
    invokeMock.mockRejectedValueOnce(err);
    await expect(signIn("https://a")).rejects.toBe(err);
  });
});

describe("isAppError", () => {
  it("recognises the { kind, message } shape only", () => {
    expect(isAppError({ kind: "timeout", message: "x" })).toBe(true);
    expect(isAppError(new Error("x"))).toBe(false);
    expect(isAppError("x")).toBe(false);
    expect(isAppError(null)).toBe(false);
  });
});

describe("onFrame", () => {
  it("listens on the frame event and maps payloads", async () => {
    const unlisten = vi.fn();
    listenMock.mockResolvedValue(unlisten);
    const cb = vi.fn();
    const off = await onFrame(cb);
    expect(off).toBe(unlisten);
    expect(listenMock.mock.calls[0][0]).toBe("viewer://frame");
    const handler = listenMock.mock.calls[0][1] as (e: { payload: FramePayload }) => void;
    const payload: FramePayload = { server: "https://w", frame: { type: "resync" } };
    handler({ payload });
    expect(cb).toHaveBeenCalledWith(payload);
  });
});
