import { expect, test } from "bun:test";

import { classifyDirent } from "../src/kits/fs/_dirent";

function makeEntry(
  name: string,
  kind: "dir" | "file" | "symlink" | "unknown",
): {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
} {
  return {
    name,
    isDirectory: () => kind === "dir",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

function makeStat(kind: "dir" | "file" | "symlink"): {
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
} {
  return {
    isDirectory: () => kind === "dir",
    isSymbolicLink: () => kind === "symlink",
  };
}

test("classifyDirent skips symlinks without calling lstat", async () => {
  let called = false;
  const kind = await classifyDirent("/tmp", makeEntry("link", "symlink"), async () => {
    called = true;
    return makeStat("file");
  });

  expect(kind).toBe("skip");
  expect(called).toBe(false);
});

test("classifyDirent returns dir/file without calling lstat when Dirent provides type", async () => {
  let called = false;
  const lstatFn = async () => {
    called = true;
    return makeStat("dir");
  };

  expect(await classifyDirent("/tmp", makeEntry("d", "dir"), lstatFn)).toBe("dir");
  expect(await classifyDirent("/tmp", makeEntry("f", "file"), lstatFn)).toBe("file");
  expect(called).toBe(false);
});

test("classifyDirent falls back to lstat for unknown types", async () => {
  const kind = await classifyDirent("/tmp", makeEntry("u", "unknown"), async (p) => {
    expect(p).toContain("u");
    return makeStat("dir");
  });

  expect(kind).toBe("dir");
});

test("classifyDirent treats lstat symlinks as skip", async () => {
  const kind = await classifyDirent("/tmp", makeEntry("u", "unknown"), async () => {
    return makeStat("symlink");
  });

  expect(kind).toBe("skip");
});

test("classifyDirent treats unknown non-directories as file", async () => {
  const kind = await classifyDirent("/tmp", makeEntry("u", "unknown"), async () => {
    return makeStat("file");
  });

  expect(kind).toBe("file");
});

test("classifyDirent treats lstat errors as file", async () => {
  const kind = await classifyDirent("/tmp", makeEntry("u", "unknown"), async () => {
    throw new Error("boom");
  });

  expect(kind).toBe("file");
});
