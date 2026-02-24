import { expect, test } from "bun:test";

import { viewTree } from "../src/kits/fs/index";

test("viewTree renders a token-efficient indent tree", async () => {
  const out = await viewTree({
    root: "/tmp/my-repo",
    nodes: {
      ".": { dirs: ["src"], files: ["package.json"] },
      src: { files: ["index.ts"], more: 2 },
    },
  });

  expect(out).toBe(
    ["my-repo/", "  src/... (+2)", "    index.ts", "  package.json"].join("\n"),
  );
});

test("viewTree renders errors as name/! (CODE)", async () => {
  const out = await viewTree({
    root: "/tmp/repo",
    nodes: {
      ".": { dirs: ["secrets"] },
      secrets: { error: "EACCES" },
    },
  });

  expect(out).toBe(["repo/", "  secrets/! (EACCES)"].join("\n"));
});

test("viewTree escapes control characters in error strings", async () => {
  const out = await viewTree({
    root: "/tmp/repo",
    nodes: {
      ".": { dirs: ["secrets"] },
      secrets: { error: "EACCES\nINJECT" },
    },
  });

  // Must remain one-item-per-line even for arbitrary scan objects.
  expect(out.split("\n")).toEqual(["repo/", "  secrets/! (EACCES\\nINJECT)"]);
});

test("viewTree treats missing child nodes as unexpanded (name/...)", async () => {
  const out = await viewTree({
    root: "/tmp/repo",
    nodes: {
      ".": { dirs: ["src"] },
      // Intentionally missing nodes["src"].
    },
  });

  expect(out).toBe(["repo/", "  src/..."].join("\n"));
});

test("viewTree escapes control characters in names", async () => {
  const out = await viewTree({
    root: "/tmp/repo",
    nodes: {
      ".": { files: ["a\nb.txt", "c\rd.txt", "e\tf.txt", "g\x1bh.txt", "i\x7fj.txt"] },
    },
  });

  expect(out).toContain("  a\\nb.txt");
  expect(out).toContain("  c\\rd.txt");
  expect(out).toContain("  e\\tf.txt");
  expect(out).toContain("  g\\x1bh.txt");
  expect(out).toContain("  i\\x7fj.txt");

  // Make it difficult to smuggle ANSI/OSC escapes into logs/terminals.
  expect(out).not.toContain("\x1b");
});

test("viewTree escapes unicode line separators and bidi controls in names", async () => {
  const out = await viewTree({
    root: "/tmp/repo",
    nodes: {
      ".": { files: ["a\u2028b.txt", "c\u2029d.txt", "e\u202ef.txt", "g\u2066h.txt"] },
    },
  });

  expect(out).toContain("  a\\u2028b.txt");
  expect(out).toContain("  c\\u2029d.txt");
  expect(out).toContain("  e\\u202ef.txt");
  expect(out).toContain("  g\\u2066h.txt");
  expect(out).not.toContain("\u2028");
  expect(out).not.toContain("\u202e");
});

test("viewTree preserves a trailing backslash in the basename on POSIX", async () => {
  const out = await viewTree({
    root: "/tmp/foo\\",
    nodes: {
      ".": { files: ["a.txt"] },
    },
  });

  expect(out).toBe(["foo\\/", "  a.txt"].join("\n"));
});

test("viewTree renders the POSIX root directory as a single slash", async () => {
  const out = await viewTree({
    root: "/",
    nodes: {
      ".": { files: ["a.txt"] },
    },
  });

  expect(out).toBe(["/", "  a.txt"].join("\n"));
});
