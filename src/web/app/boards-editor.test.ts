// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createBoardsEditor, ManifestUnreadableError } from "./boards-editor.js";

describe("createBoardsEditor", () => {
  it("throws ManifestUnreadableError, before mounting GrapesJS, when manifest.json is not JSON", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const panel = () => document.createElement("div");
    expect(() =>
      createBoardsEditor({
        container,
        panels: { layers: panel(), styles: panel(), selectors: panel(), traits: panel() },
        files: { "manifest.json": "{not json", "boards/home.html": "<!doctype html><title>x</title>" },
        editable: true,
      }),
    ).toThrow(ManifestUnreadableError);
    expect(container.childElementCount).toBe(0);
  });
});
