import { describe, expect, test } from "bun:test";
import { type as schema } from "arktype";
import { defineTool } from "../src/defineTool";

describe("defineTool", () => {
  test("attaches meta and validates input", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ n: "number" }),
      output: schema("number"),
      fn: async ({ n }) => n + 1,
    });

    expect(tool.meta.kit).toBe("k");
    expect(tool.meta.name).toBe("t");
    expect(tool.meta.hidden).toBe(false);

    await expect(tool({ n: 1 })).resolves.toBe(2);
    // @ts-expect-error - runtime should reject wrong shape
    await expect(tool({ n: "nope" })).rejects.toBeInstanceOf(Error);
  });

  test("supports meta.hidden for unlisted tools", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      hidden: true,
      input: schema({ n: "number" }),
      output: schema("number"),
      fn: async ({ n }) => n,
    });

    expect(tool.meta.hidden).toBe(true);
    await expect(tool({ n: 1 })).resolves.toBe(1);
  });

  test("treats top-level undefined keys as omitted", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ "cursor?": "string" }),
      output: schema({ hasCursor: "boolean" }),
      fn: async (input) => ({
        hasCursor: Object.prototype.hasOwnProperty.call(input, "cursor"),
      }),
    });

    await expect(tool({ cursor: undefined })).resolves.toEqual({ hasCursor: false });
  });

  test("does not treat null as omitted", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ "cursor?": "string" }),
      output: schema("string"),
      fn: async ({ cursor }) => cursor ?? "none",
    });

    await expect(tool({ cursor: null as any })).rejects.toBeInstanceOf(Error);
  });

  test("does not deep-strip undefined in nested objects", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ inner: schema({ x: "string" }) }),
      output: schema("string"),
      fn: async ({ inner }) => inner.x,
    });

    await expect(tool({ inner: { x: undefined as any } })).rejects.toBeInstanceOf(Error);
  });

  test("still rejects undefined for required keys", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ repo: "string" }),
      output: schema("string"),
      fn: async ({ repo }) => repo,
    });

    await expect(tool({ repo: undefined as any })).rejects.toBeInstanceOf(Error);
  });

  test("rejects non-object payloads even if schema is permissive", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({}),
      output: schema("string"),
      fn: async () => "ok",
    });

    await expect((tool as any)([])).rejects.toThrow(/single object input/i);
    await expect((tool as any)(null)).rejects.toThrow(/single object input/i);
  });

  test("does not validate output by default", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ n: "number" }),
      output: schema("number"),
      fn: async () => "not-a-number" as any,
    });

    await expect(tool({ n: 1 })).resolves.toBe("not-a-number");
  });

  test("validateOutput=true rejects invalid output", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ n: "number" }),
      output: schema("number"),
      validateOutput: true,
      fn: async () => "not-a-number" as any,
    });

    await expect(tool({ n: 1 })).rejects.toBeInstanceOf(Error);
  });

  test("validateOutput=true accepts valid output", async () => {
    const tool = defineTool({
      kit: "k",
      name: "t",
      summary: "s",
      input: schema({ n: "number" }),
      output: schema("number"),
      validateOutput: true,
      fn: async ({ n }) => n + 1,
    });

    await expect(tool({ n: 1 })).resolves.toBe(2);
  });
});
