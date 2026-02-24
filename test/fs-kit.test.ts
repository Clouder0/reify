import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fsKit, { fsKitImport, readTextWindow, scanTree, viewTree } from "../src/kits/fs/index";

test("scanTree doc mentions unlisted formatPath helper", () => {
  expect(scanTree.meta.doc).toContain("formatPath");
  expect(scanTree.meta.doc).toContain(`reify:tool/${fsKitImport}#formatPath`);
});

test("fs kit exposes a bounded browse/read surface", async () => {
  expect(typeof fsKit.docs["index"].doc).toBe("string");

  // Explicit wiring: kit.tools should reference the named exports.
  expect(fsKit.tools.readTextWindow).toBe(readTextWindow);

  // Legacy/unbounded tools are intentionally removed.
  expect("readText" in fsKit.tools).toBe(false);
  expect("writeText" in fsKit.tools).toBe(false);
  expect("listDir" in fsKit.tools).toBe(false);

  const dir = join(process.cwd(), ".tmp-reify");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), "hi", "utf8");

    const out = await readTextWindow({ path: join(dir, "a.txt"), startLine: 1, maxLines: 10 });
    expect(out.text).toBe("hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanTree output renders correctly via viewTree", async () => {
  const dir = join(process.cwd(), ".tmp-reify-fs-tree-integration");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, "b"), { recursive: true });
    await mkdir(join(dir, "a"), { recursive: true });
    await writeFile(join(dir, "c.txt"), "c", "utf8");

    const scan = await scanTree({
      path: dir,
      maxDepth: 1,
      maxEntries: 100,
      maxEntriesPerDir: 100,
    });
    const out = await viewTree(scan);

    expect(out).toBe(
      [
        ".tmp-reify-fs-tree-integration/",
        "  a/",
        "  b/",
        "  c.txt",
      ].join("\n"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
