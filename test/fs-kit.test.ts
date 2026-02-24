import { expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import fsKit, { fsKitImport, listDir, readText, scanTree, viewTree } from "../src/kits/fs/index";

test("scanTree doc mentions internal formatPath helper", () => {
  expect(scanTree.meta.doc).toContain("formatPath");
  expect(scanTree.meta.doc).toContain(`reify:tool/${fsKitImport}#formatPath`);
});

test("fs kit reads and lists", async () => {
  expect(typeof fsKit.docs["index"].doc).toBe("string");
  expect(fsKit.tools.readText).toBe(readText);

  const dir = join(process.cwd(), ".tmp-reify");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), "hi", "utf8");

    const s = await readText({ path: join(dir, "a.txt") });
    expect(s).toBe("hi");

    const entries = await listDir({ path: dir, recursive: false });
    expect(entries).toContain("a.txt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recursive listing skips dangling symlinks", async () => {
  const dir = join(process.cwd(), ".tmp-reify-symlink");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), "ok", "utf8");

    try {
      await symlink("./missing-target", join(dir, "dangling"));
    } catch (error) {
      // Some environments disallow symlink creation for unprivileged users.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const entries = await listDir({ path: dir, recursive: true });
    expect(entries).toContain("a.txt");
    expect(entries).not.toContain("dangling");
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
