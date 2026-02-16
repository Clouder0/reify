import { describe, expect, test } from "bun:test";
import { type as schema } from "arktype";

import { defineKit } from "../src/defineKit";
import { defineTool } from "../src/defineTool";

describe("defineKit", () => {
  test("returns the kit when invariants hold", () => {
    const hello = defineTool({
      kit: "demo",
      name: "hello",
      summary: "Say hello",
      input: schema({ name: "string" }),
      output: schema("string"),
      fn: async ({ name }) => `hello ${name}`,
    });

    const kit = defineKit({
      name: "demo",
      summary: "Demo kit",
      docs: {
        index: { summary: "Overview", doc: "# Demo" },
      },
      tools: { hello },
    });

    expect(kit.name).toBe("demo");
    expect(kit.tools.hello).toBe(hello);
  });

  test("throws if a tool key does not match tool.meta.name", () => {
    const hello = defineTool({
      kit: "demo",
      name: "hello",
      summary: "Say hello",
      input: schema({}),
      output: schema("string"),
      fn: async () => "ok",
    });

    expect(() =>
      defineKit({
        name: "demo",
        summary: "Demo kit",
        docs: { index: { summary: "Overview", doc: "# Demo" } },
        // Mismatch: stored under a different key than meta.name.
        tools: { goodbye: hello as any },
      }),
    ).toThrow(/name mismatch/i);
  });

  test("throws if tool.meta.kit does not match kit.name", () => {
    const hello = defineTool({
      kit: "other",
      name: "hello",
      summary: "Say hello",
      input: schema({}),
      output: schema("string"),
      fn: async () => "ok",
    });

    expect(() =>
      defineKit({
        name: "demo",
        summary: "Demo kit",
        docs: { index: { summary: "Overview", doc: "# Demo" } },
        tools: { hello: hello as any },
      }),
    ).toThrow(/kit mismatch/i);
  });

  test("throws if tool meta.input schema is malformed", () => {
    const malformedInput = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: "Malformed",
        input: { nope: true },
        output: schema("string"),
      },
    });

    expect(() =>
      defineKit({
        name: "demo",
        summary: "Demo kit",
        docs: { index: { summary: "Overview", doc: "# Demo" } },
        tools: { bad: malformedInput as any },
      }),
    ).toThrow(/input/i);
  });

  test("throws if tool meta.output schema is malformed", () => {
    const malformedOutput = Object.assign(async () => "ok", {
      meta: {
        kit: "demo",
        name: "bad",
        summary: "Malformed",
        input: schema({ ok: "string" }),
        output: { nope: true },
      },
    });

    expect(() =>
      defineKit({
        name: "demo",
        summary: "Demo kit",
        docs: { index: { summary: "Overview", doc: "# Demo" } },
        tools: { bad: malformedOutput as any },
      }),
    ).toThrow(/output/i);
  });

  test("throws if tool meta.doc is present but not a string", () => {
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

    expect(() =>
      defineKit({
        name: "demo",
        summary: "Demo kit",
        docs: { index: { summary: "Overview", doc: "# Demo" } },
        tools: { bad: malformedDoc as any },
      }),
    ).toThrow(/meta\.doc/i);
  });
});
