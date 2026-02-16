import { describe, expect, test } from "bun:test";
import { type as schema } from "arktype";

import { defineTool } from "../src/defineTool";
import { inspectTool } from "../src/inspectTool";

describe("inspectTool contract readability", () => {
  test("keeps complex input/output constraints in expression form", () => {
    const search = defineTool({
      kit: "demo",
      name: "search",
      summary: "Search records",
      input: schema({
        query: "string | number",
        filters: {
          "tags?": "string[]",
          "limit?": "0 <= number <= 100",
        },
      }),
      output: schema({
        ok: "boolean",
        entries: "string[]",
      }),
      fn: async () => ({ ok: true, entries: [] }),
    });

    const info = inspectTool(search);
    expect(info.input.expression).toContain("query: number | string");
    expect(info.input.expression).toContain("tags?: string[]");
    expect(info.input.expression).toContain("limit?: number <= 100 & >= 0");
    expect(info.output.expression).toContain("ok: boolean");
    expect(info.output.expression).toContain("entries: string[]");
  });
});
