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
