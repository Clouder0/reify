import { describe, expect, test } from "bun:test";

import fsKit from "../src/kits/fs/index";
import { listDocs } from "../src/listDocs";
import { listTools } from "../src/listTools";

describe("kit-scoped listing helpers", () => {
  test("listTools(kit) returns a sorted summary index", () => {
    expect(listTools(fsKit)).toEqual([
      { name: "listDir", summary: "List directory entries (optionally recursive)" },
      { name: "readText", summary: "Read a file as UTF-8 text" },
      { name: "writeText", summary: "Write UTF-8 text to a file" },
    ]);
  });

  test("listDocs(kit) returns a sorted summary index", () => {
    const docs = listDocs(fsKit);
    expect(docs).toEqual([
      { name: "changelog", summary: "Recent changes" },
      { name: "concepts/paths", summary: "Concepts: paths and cwd" },
      { name: "index", summary: "Filesystem kit overview" },
      { name: "migrations", summary: "Breaking changes and migrations" },
      { name: "recipes/read-write", summary: "Recipe: read-modify-write" },
    ]);

    for (const item of docs) {
      expect("doc" in (item as Record<string, unknown>)).toBe(false);
    }
  });
});
