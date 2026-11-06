import { describe, expect, it } from "vitest";
import { findResponse, hasServerRequest } from "./jsonrpc.js";

describe("findResponse", () => {
  it("finds the response in a JSON body", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 3, result: { ok: true } });
    expect(findResponse(body, "application/json", 3)).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
  });

  it("finds the response in a JSON array batch", () => {
    const body = JSON.stringify([
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
      { jsonrpc: "2.0", id: 2, result: { a: 1 } },
    ]);
    expect(findResponse(body, "application/json; charset=utf-8", 2)?.result).toEqual({ a: 1 });
  });

  it("skips a notification frame in an SSE body", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
      'event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"x":1}}\n\n';
    expect(findResponse(body, "text/event-stream", 5)?.result).toEqual({ x: 1 });
  });

  it("joins a data field split over two lines", () => {
    const body = 'data: {"jsonrpc":"2.0","id":4,\ndata: "result":{"y":2}}\n\n';
    expect(findResponse(body, "text/event-stream", 4)?.result).toEqual({ y: 2 });
  });

  it("handles CRLF frames and no space after data:", () => {
    const body = 'data:{"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\n';
    expect(findResponse(body, "text/event-stream", 1)).toBeDefined();
  });

  it("returns undefined for another id", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 9, result: {} });
    expect(findResponse(body, "application/json", 1)).toBeUndefined();
  });

  it("skips malformed frames", () => {
    const body = 'data: {not json\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":1}}\n\n';
    expect(findResponse(body, "text/event-stream", 1)?.result).toEqual({ ok: 1 });
  });

  it("returns undefined for a malformed JSON body", () => {
    expect(findResponse("nope", "application/json", 1)).toBeUndefined();
    expect(findResponse("", undefined, 1)).toBeUndefined();
  });

  it("does not treat a server request with the same id as the response", () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sampling/createMessage" });
    expect(findResponse(body, "application/json", 1)).toBeUndefined();
  });
});

describe("hasServerRequest", () => {
  it("is true for a server request", () => {
    const body = '{"jsonrpc":"2.0","id":7,"method":"sampling/createMessage"}';
    expect(hasServerRequest(body, "application/json")).toBe(true);
    expect(hasServerRequest(`data: ${body}\n\n`, "text/event-stream")).toBe(true);
  });

  it("is false for a notification", () => {
    const body = '{"jsonrpc":"2.0","method":"notifications/message"}';
    expect(hasServerRequest(body, "application/json")).toBe(false);
  });

  it("is false for a plain response", () => {
    expect(hasServerRequest('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json")).toBe(false);
  });
});
