import { describe, expect, test } from "bun:test";

import { formatValue } from "../src/index";

describe("formatValue", () => {
  test("returns strings as-is", () => {
    expect(formatValue("hello\nworld")).toBe("hello\nworld");
  });

  test("truncates long strings but preserves tail context", () => {
    const tail = "TAIL_MARKER";
    const long = "a".repeat(25_000) + tail;
    const out = formatValue(long);

    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toContain(tail);
    expect(out).toContain("<truncated");
    expect(out).toContain("chars>");
  });

  test("prints objects with stable key order", () => {
    const out = formatValue({ b: 1, a: 2 });
    expect(out).toContain("{ a: 2, b: 1 }");
  });

  test("does not crash on circular references", () => {
    const o: any = {};
    o.self = o;
    const out = formatValue(o);
    expect(out).toContain("[Circular");
  });

  test("preserves tail of nested long strings (stderr-style)", () => {
    const stderrTail = "ERR_TAIL";
    const stderr = "x".repeat(35_000) + stderrTail;
    const out = formatValue({ stderr });

    expect(out.length).toBeLessThanOrEqual(20_000);
    expect(out).toContain(stderrTail);
    expect(out).toContain("<truncated");
  });

  test("formats Headers and URLSearchParams with visible entries (Bun web types)", () => {
    const headers = new Headers({ b: "2", a: "1" });
    const headerOut = formatValue(headers, { maxChars: 2_000 });
    const headerA = headerOut.indexOf('"a"');
    const headerB = headerOut.indexOf('"b"');
    expect(headerA).toBeGreaterThanOrEqual(0);
    expect(headerB).toBeGreaterThanOrEqual(0);
    expect(headerA).toBeLessThan(headerB);

    const params = new URLSearchParams({ b: "2", a: "1" });
    const paramsOut = formatValue(params, { maxChars: 2_000 });
    const paramsA = paramsOut.indexOf('"a"');
    const paramsB = paramsOut.indexOf('"b"');
    expect(paramsA).toBeGreaterThanOrEqual(0);
    expect(paramsB).toBeGreaterThanOrEqual(0);
    expect(paramsA).toBeLessThan(paramsB);
  });
});
