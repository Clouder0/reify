import { describe, expect, test } from "bun:test";
import { type as schema } from "arktype";

import { defineTool } from "../src/defineTool";
import { inspectTool } from "../src/inspectTool";

describe("inspectTool", () => {
  test("inspects a tool into JSON-friendly input/output strings", () => {
    const t = defineTool({
      kit: "demo",
      name: "hello",
      summary: "Say hello",
      input: schema({
        name: schema("string").describe("Name"),
        excited: schema("boolean").describe("Add exclamation").default(false),
      }),
      output: schema({
        message: "string",
      }),
      doc: "# hello\n\nExample...",
      fn: async ({ name, excited }) => ({ message: excited ? `hello ${name}!` : `hello ${name}` }),
    });

    const info = inspectTool(t);
    expect(info).toEqual({
      kit: "demo",
      name: "hello",
      summary: "Say hello",
      input: {
        expression: "{ name: string, excited: boolean = false }",
        description: "{ name: Name, excited?: Add exclamation }",
      },
      output: {
        expression: "{ message: string }",
        description: "{ message: a string }",
      },
      doc: "# hello\n\nExample...",
    });
  });

  test("includes hidden=true for unlisted tools", () => {
    const t = defineTool({
      kit: "demo",
      name: "secret",
      summary: "Internal",
      hidden: true,
      input: schema({ ok: "string" }),
      output: schema({ ok: "string" }),
      fn: async ({ ok }) => ({ ok }),
    });

    const info = inspectTool(t);
    expect(info.hidden).toBe(true);
  });

  test("throws a clear error when meta.input is malformed", () => {
    const malformedInput = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: "Malformed",
        input: { nope: true },
        output: schema({ ok: "string" }),
      },
    });

    expect(() => inspectTool(malformedInput as any)).toThrow(/demo\.bad.*meta\.input/i);
  });

  test("throws a clear error when meta.output is malformed", () => {
    const malformedOutput = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: "Malformed",
        input: schema({ ok: "string" }),
        output: { nope: true },
      },
    });

    expect(() => inspectTool(malformedOutput as any)).toThrow(/demo\.bad.*meta\.output/i);
  });

  test("throws a clear error when meta.summary is not a string", () => {
    const malformedSummary = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: { nope: true },
        input: schema({ ok: "string" }),
        output: schema({ ok: "string" }),
      },
    });

    expect(() => inspectTool(malformedSummary as any)).toThrow(/demo\.bad.*meta\.summary/i);
  });

  test("throws a clear error when meta.doc is not a string", () => {
    const malformedDoc = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: "Malformed",
        input: schema({ ok: "string" }),
        output: schema({ ok: "string" }),
        doc: 123,
      },
    });

    expect(() => inspectTool(malformedDoc as any)).toThrow(/demo\.bad.*meta\.doc/i);
  });

  test("throws a clear error when meta.hidden is not a boolean", () => {
    const malformedHidden = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: "Malformed",
        hidden: "true",
        input: schema({ ok: "string" }),
        output: schema({ ok: "string" }),
      },
    });

    expect(() => inspectTool(malformedHidden as any)).toThrow(/demo\.bad.*meta\.hidden/i);
  });

  test("throws a clear error when tool metadata is missing", () => {
    const withoutMeta = Object.assign(async () => "ok", {});

    expect(() => inspectTool(withoutMeta as any)).toThrow(/invalid.*meta|cannot inspect/i);
  });

  test("throws a clear error when tool is null", () => {
    expect(() => inspectTool(null as any)).toThrow(/cannot inspect|invalid tool/i);
  });

  test("throws a clear error when tool is undefined", () => {
    expect(() => inspectTool(undefined as any)).toThrow(/cannot inspect|invalid tool/i);
  });
});
