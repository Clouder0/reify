import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { readTextWindow } from "../src/kits/fs/index";

test("readTextWindow returns requested first window with continuation", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: 1, maxLines: 2 });

    expect(out).toEqual({
      text: "a\nb\n",
      startLine: 1,
      endLine: 2,
      nextStartLine: 3,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow returns empty window when startLine is past EOF", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-eof");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\n", "utf8");

    const out = await readTextWindow({ path, startLine: 99, maxLines: 10 });

    expect(out).toEqual({
      text: "",
      startLine: 99,
      endLine: null,
      nextStartLine: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow preserves CRLF/LF bytes exactly", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-endings");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\r\nb\nc\r\nd", "utf8");

    const out = await readTextWindow({ path, startLine: 2, maxLines: 3 });
    const expectedText = "b\nc\r\nd";

    expect(out.text).toBe(expectedText);
    expect(Buffer.from(out.text, "utf8")).toEqual(Buffer.from(expectedText, "utf8"));
    expect(out.startLine).toBe(2);
    expect(out.endLine).toBe(4);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow rejects invalid startLine and maxLines", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-invalid");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\n", "utf8");

    await expect(readTextWindow({ path, startLine: 0, maxLines: 1 })).rejects.toThrow(
      "startLine must be an integer >= 1",
    );
    await expect(readTextWindow({ path, startLine: 1.5, maxLines: 1 })).rejects.toThrow(
      "startLine must be an integer >= 1",
    );
    await expect(readTextWindow({ path, startLine: 1, maxLines: 0 })).rejects.toThrow(
      "maxLines must be an integer >= 1",
    );
    await expect(readTextWindow({ path, startLine: 1, maxLines: 1.5 })).rejects.toThrow(
      "maxLines must be an integer >= 1",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow rejects maxLines above 1000", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-max-lines");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\n", "utf8");

    await expect(readTextWindow({ path, startLine: 1, maxLines: 1001 })).rejects.toThrow(
      "maxLines must be <= 1000",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow keeps last line without newline unchanged", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-no-trailing-newline");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc", "utf8");

    const out = await readTextWindow({ path, startLine: 3, maxLines: 1 });

    expect(out).toEqual({
      text: "c",
      startLine: 3,
      endLine: 3,
      nextStartLine: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow defaults startLine=1 and maxLines=200", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-defaults");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    const allLines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}\n`).join("");
    const first200 = Array.from({ length: 200 }, (_, i) => `line-${i + 1}\n`).join("");
    await writeFile(path, allLines, "utf8");

    const out = await readTextWindow({ path });

    expect(out).toEqual({
      text: first200,
      startLine: 1,
      endLine: 200,
      nextStartLine: 201,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow returns null nextStartLine on last page", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-last-page");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\n", "utf8");

    const out = await readTextWindow({ path, startLine: 3, maxLines: 10 });

    expect(out).toEqual({
      text: "c\n",
      startLine: 3,
      endLine: 3,
      nextStartLine: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
