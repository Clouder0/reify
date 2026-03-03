import { describe, expect, test } from "bun:test";
import { type as schema } from "arktype";

import { defineKit } from "../src/defineKit";
import { defineTool } from "../src/defineTool";
import fsKit from "../src/kits/fs/index";
import { listDocs } from "../src/listDocs";
import { listTools } from "../src/listTools";

describe("kit-scoped listing helpers", () => {
  test("listTools(kit) returns a sorted summary index", () => {
    expect(listTools(fsKit)).toEqual([
      { name: "readTextWindow", summary: "Read a line window from a UTF-8 text file" },
      { name: "scanTree", summary: "Scan a directory into a bounded, deterministic nodes map" },
      { name: "searchText", summary: "Search text under a directory (ripgrep wrapper)" },
    ]);
  });

  test("listTools(kit) omits tools marked meta.hidden", () => {
    const visible = defineTool({
      kit: "demo",
      name: "visible",
      summary: "Visible",
      input: schema({ n: "number" }),
      output: schema("number"),
      fn: async ({ n }) => n,
    });

    const hidden = defineTool({
      kit: "demo",
      name: "hidden",
      summary: "Hidden",
      hidden: true,
      input: schema({ n: "number" }),
      output: schema("number"),
      fn: async ({ n }) => n,
    });

    const kit = defineKit({
      name: "demo",
      summary: "Demo kit",
      docs: { index: { summary: "Overview", doc: "" } },
      tools: { visible, hidden },
    });

    expect(listTools(kit)).toEqual([{ name: "visible", summary: "Visible" }]);
  });

  test("listDocs(kit) returns a sorted summary index", () => {
    const docs = listDocs(fsKit);
    expect(docs).toEqual([
      { name: "changelog", summary: "Recent changes" },
      { name: "concepts/paths", summary: "Concepts: paths and cwd" },
      { name: "index", summary: "Filesystem kit overview" },
      { name: "migrations", summary: "Breaking changes and migrations" },
      { name: "recipes/browse-read", summary: "Recipe: browse + read" },
    ]);

    for (const item of docs) {
      expect("doc" in (item as Record<string, unknown>)).toBe(false);
    }
  });
});
