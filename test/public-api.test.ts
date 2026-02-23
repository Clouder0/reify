import { expect, test } from "bun:test";

import * as reify from "../src/index";

test("public API is kit-major", () => {
  expect(typeof reify.defineTool).toBe("function");
  expect(typeof reify.defineKit).toBe("function");
  expect(typeof reify.listKits).toBe("function");
  expect(typeof reify.inspectTool).toBe("function");
  expect(typeof reify.listTools).toBe("function");
  expect(typeof reify.listDocs).toBe("function");
  expect(typeof reify.formatValue).toBe("function");

  // Global ref-inspection registry API is intentionally not exported.
  expect("inspect" in reify).toBe(false);
});

test("listKits() includes built-in kits + import specifiers", () => {
  const kits = reify.listKits();
  expect(Array.isArray(kits)).toBe(true);

  const fs = kits.find((k) => k.name === "fs");
  expect(fs).toBeTruthy();
  expect(fs?.import).toBe("@reify-ai/reify/kits/fs");
});
