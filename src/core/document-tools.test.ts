import { describe, expect, it } from "vitest";
import { boardFormatRulesText } from "./documents/boards/rules.js";
import { DOCUMENT_WRITE_TOOL_DEFS } from "./document-tools.js";

describe("document write tools", () => {
  it("give a native agent the same board rules a coding agent gets", () => {
    for (const name of ["doc_create", "doc_publish_version"]) {
      const def = DOCUMENT_WRITE_TOOL_DEFS.find((d) => d.name === name);
      expect(def?.description).toContain(boardFormatRulesText());
    }
  });
});

describe("links between documents", () => {
  it("tell an agent to link by pagePath, never an invented address", () => {
    for (const name of ["doc_create", "doc_publish_version"]) {
      expect(DOCUMENT_WRITE_TOOL_DEFS.find((d) => d.name === name)?.description).toMatch(/pagePath.*\/d\/<id>/);
    }
  });
});
