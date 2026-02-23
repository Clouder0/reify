import { expect, test } from "bun:test";
import { mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { scanTree } from "../src/kits/fs/index";

test("scanTree returns a deterministic nodes map (sorted, dir-first)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-scan-tree-order");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, "b"), { recursive: true });
    await mkdir(join(dir, "a"), { recursive: true });
    await writeFile(join(dir, "z.txt"), "z", "utf8");
    await writeFile(join(dir, "a.txt"), "a", "utf8");

    // Default excludes should hide these.
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "config"), "x", "utf8");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeFile(join(dir, "node_modules", "x.txt"), "x", "utf8");

    const out = await scanTree({
      path: dir,
      maxDepth: 2,
      maxEntries: 100,
      maxEntriesPerDir: 100,
    });

    expect(out.root).toBe(await realpath(dir));
    expect(out.nodes["."].dirs).toEqual(["a", "b"]);
    expect(out.nodes["."].files).toEqual(["a.txt", "z.txt"]);
    expect(".git" in (out.nodes as any)).toBe(false);
    expect("node_modules" in (out.nodes as any)).toBe(false);

    // Included dirs always have a node entry (even if empty).
    expect(out.nodes["a"]).toBeTruthy();
    expect(out.nodes["b"]).toBeTruthy();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanTree clips per-directory and sets more to omitted direct children count", async () => {
  const dir = join(process.cwd(), ".tmp-reify-scan-tree-more");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, "c"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    await mkdir(join(dir, "a"), { recursive: true });
    await writeFile(join(dir, "c.txt"), "c", "utf8");
    await writeFile(join(dir, "b.txt"), "b", "utf8");
    await writeFile(join(dir, "a.txt"), "a", "utf8");

    const out = await scanTree({
      path: dir,
      maxDepth: 1,
      maxEntries: 100,
      maxEntriesPerDir: 2,
    });

    expect(out.nodes["."].dirs).toEqual(["a", "b"]);
    expect(out.nodes["."].files).toBeUndefined();
    expect(out.nodes["."].more).toBe(4); // total 6 children, included 2
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanTree enforces maxDepth by emitting unexpanded child nodes with more: true", async () => {
  const dir = join(process.cwd(), ".tmp-reify-scan-tree-depth");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, "deep", "inner"), { recursive: true });
    await writeFile(join(dir, "deep", "inner", "x.txt"), "x", "utf8");

    const out = await scanTree({
      path: dir,
      maxDepth: 1,
      maxEntries: 100,
      maxEntriesPerDir: 50,
    });

    expect(out.nodes["."].dirs).toEqual(["deep"]);
    expect(out.nodes["deep"].more).toBe(true);
    expect(out.nodes["deep"].dirs).toBeUndefined();
    expect(out.nodes["deep"].files).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanTree enforces global maxEntries and marks unexpanded nodes with more: true", async () => {
  const dir = join(process.cwd(), ".tmp-reify-scan-tree-global-budget");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(join(dir, "a"), { recursive: true });
    await mkdir(join(dir, "b"), { recursive: true });
    await writeFile(join(dir, "z.txt"), "z", "utf8");

    const out = await scanTree({
      path: dir,
      maxDepth: 2,
      maxEntries: 1,
      maxEntriesPerDir: 50,
    });

    expect(out.nodes["."].dirs).toEqual(["a"]);
    expect(out.nodes["."].files).toBeUndefined();
    expect(out.nodes["."].more).toBe(2); // omitted: "b" + "z.txt"

    // "a" is present but couldn't be expanded (budget exhausted).
    expect(out.nodes["a"]).toBeTruthy();
    expect(out.nodes["a"].more).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanTree skips symlinks", async () => {
  const dir = join(process.cwd(), ".tmp-reify-scan-tree-symlink");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.txt"), "ok", "utf8");

    try {
      await symlink("./a.txt", join(dir, "link"));
    } catch (error) {
      // Some environments disallow symlink creation for unprivileged users.
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const out = await scanTree({
      path: dir,
      maxDepth: 1,
      maxEntries: 100,
      maxEntriesPerDir: 50,
    });

    expect(out.nodes["."].files).toEqual(["a.txt"]);
    expect(out.nodes["."].files).not.toContain("link");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
