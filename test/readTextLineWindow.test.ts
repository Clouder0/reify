import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readTextLineWindow } from "../src/kits/fs/index";

test("readTextLineWindow pages within a single line", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "abcdefghij\n", "utf8");

    const first = await readTextLineWindow({ path, line: 1, startChar: 0, maxChars: 4 });
    expect(first).toEqual({
      found: true,
      line: 1,
      startChar: 0,
      endChar: 4,
      nextStartChar: 4,
      text: "abcd",
      eol: "\n",
    });

    const second = await readTextLineWindow({ path, line: 1, startChar: 4, maxChars: 4 });
    expect(second).toEqual({
      found: true,
      line: 1,
      startChar: 4,
      endChar: 8,
      nextStartChar: 8,
      text: "efgh",
      eol: "\n",
    });

    const third = await readTextLineWindow({ path, line: 1, startChar: 8, maxChars: 4 });
    expect(third).toEqual({
      found: true,
      line: 1,
      startChar: 8,
      endChar: 10,
      nextStartChar: null,
      text: "ij",
      eol: "\n",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow returns found=false when line is past EOF", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-eof");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\n", "utf8");

    const out = await readTextLineWindow({ path, line: 2, startChar: 0, maxChars: 10 });
    expect(out).toEqual({
      found: false,
      line: 2,
      startChar: 0,
      endChar: null,
      nextStartChar: null,
      text: "",
      eol: "",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow supports negative line (-1 is last line)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-negative");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "first\nsecond\n", "utf8");

    const out = await readTextLineWindow({ path, line: -1, startChar: 1, maxChars: 3 });
    expect(out).toEqual({
      found: true,
      line: -1,
      startChar: 1,
      endChar: 4,
      nextStartChar: 4,
      text: "eco",
      eol: "\n",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow returns found=false when negative line is past BOF", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-negative-oob");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "only\n", "utf8");

    const out = await readTextLineWindow({ path, line: -2, startChar: 0, maxChars: 10 });
    expect(out).toEqual({
      found: false,
      line: -2,
      startChar: 0,
      endChar: null,
      nextStartChar: null,
      text: "",
      eol: "",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow rejects line=0", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-zero");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\n", "utf8");

    await expect(readTextLineWindow({ path, line: 0, startChar: 0, maxChars: 1 })).rejects.toThrow(
      "line must be an integer >= 1 or <= -1",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow preserves CRLF line endings", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-crlf");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "abcd\r\n", "utf8");

    const out = await readTextLineWindow({ path, line: 1, startChar: 1, maxChars: 2 });
    expect(out).toEqual({
      found: true,
      line: 1,
      startChar: 1,
      endChar: 3,
      nextStartChar: 3,
      text: "bc",
      eol: "\r\n",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow pages without splitting surrogate pairs", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-surrogate");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "ab😀cd\n", "utf8");

    const a = await readTextLineWindow({ path, line: 1, startChar: 0, maxChars: 3 });
    expect(a).toEqual({
      found: true,
      line: 1,
      startChar: 0,
      endChar: 2,
      nextStartChar: 2,
      text: "ab",
      eol: "\n",
    });

    const b = await readTextLineWindow({ path, line: 1, startChar: 2, maxChars: 3 });
    expect(b).toEqual({
      found: true,
      line: 1,
      startChar: 2,
      endChar: 5,
      nextStartChar: 5,
      text: "😀c",
      eol: "\n",
    });

    const c = await readTextLineWindow({ path, line: 1, startChar: 5, maxChars: 3 });
    expect(c).toEqual({
      found: true,
      line: 1,
      startChar: 5,
      endChar: 6,
      nextStartChar: null,
      text: "d",
      eol: "\n",
    });

    await expect(readTextLineWindow({ path, line: 1, startChar: 3, maxChars: 2 })).rejects.toThrow(
      "startChar must not point into the middle of a surrogate pair",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextLineWindow negative line does not split surrogate pairs", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-line-window-negative-surrogate");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "x\nab😀cd\n", "utf8");

    const a = await readTextLineWindow({ path, line: -1, startChar: 0, maxChars: 3 });
    expect(a.text).toBe("ab");

    const b = await readTextLineWindow({ path, line: -1, startChar: 2, maxChars: 3 });
    expect(b.text).toBe("😀c");

    await expect(readTextLineWindow({ path, line: -1, startChar: 3, maxChars: 2 })).rejects.toThrow(
      "startChar must not point into the middle of a surrogate pair",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
