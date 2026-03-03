import { expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { fsKitImport, readTextLineWindow, readTextWindow } from "../src/kits/fs/index";

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
      truncation: null,
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
      truncation: null,
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
    expect(out.truncation).toBeNull();
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
      "startLine must be an integer >= 1 or <= -1",
    );
    await expect(readTextWindow({ path, startLine: 1.5, maxLines: 1 })).rejects.toThrow(
      "startLine must be an integer >= 1 or <= -1",
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

test("readTextWindow supports negative startLine (-1 is last line)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: -2, maxLines: 2 });

    expect(out).toEqual({
      text: "c\nd\n",
      startLine: -2,
      endLine: -1,
      nextStartLine: null,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow negative paging uses nextStartLine toward EOF", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-page");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: -4, maxLines: 2 });
    expect(out).toEqual({
      text: "a\nb\n",
      startLine: -4,
      endLine: -3,
      nextStartLine: -2,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow clamps negative startLine when abs(startLine) exceeds file lines", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-clamp");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc\nd\n", "utf8");

    const out = await readTextWindow({ path, startLine: -99, maxLines: 2 });

    expect(out).toEqual({
      text: "a\nb\n",
      startLine: -4,
      endLine: -3,
      nextStartLine: -2,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow negative indexing handles last line without newline", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-no-eol");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "a\nb\nc", "utf8");

    const out = await readTextWindow({ path, startLine: -1, maxLines: 1 });
    expect(out).toEqual({
      text: "c",
      startLine: -1,
      endLine: -1,
      nextStartLine: null,
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow negative indexing preserves CRLF even across chunk boundaries", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-negative-crlf-chunk");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");

    // Construct a file where a CRLF occurs exactly at a 64KiB boundary in the
    // tail-scanner's backward reads. The last line length is (64KiB - 1).
    const big = "b".repeat(64 * 1024 - 1);
    await writeFile(path, `a\r\n${big}\n`, "utf8");

    const out = await readTextWindow({ path, startLine: -2, maxLines: 2, maxLineChars: 3 });

    expect(out.text).toBe(`a\r\nbbb<<<REIFY_LINE_TRUNCATED>>>\n`);
    expect(out.startLine).toBe(-2);
    expect(out.endLine).toBe(-1);
    expect(out.nextStartLine).toBeNull();
    expect(out.truncation).not.toBeNull();
    expect(out.truncation!.lines[0].line).toBe(-1);
    expect(out.truncation!.lines[0].hint.input.line).toBe(-1);
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
      truncation: null,
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
      truncation: null,
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
      truncation: null,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow truncates long lines and returns truncation metadata", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-truncation");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "abcdefghij\n", "utf8");

    const out = await readTextWindow({ path, startLine: 1, maxLines: 1, maxLineChars: 5 });

    expect(out).toEqual({
      text: "abcde<<<REIFY_LINE_TRUNCATED>>>\n",
      startLine: 1,
      endLine: 1,
      nextStartLine: null,
      truncation: {
        maxLineChars: 5,
        marker: "<<<REIFY_LINE_TRUNCATED>>>",
        lines: [
          {
            line: 1,
            shownChars: 5,
            omittedChars: 5,
            nextStartChar: 5,
            hint: {
              toolRef: `reify:tool/${fsKitImport}#readTextLineWindow`,
              input: { path, line: 1, startChar: 5, maxChars: 5 },
            },
          },
        ],
      },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow truncates long CRLF lines and preserves the ending", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-truncation-crlf");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "AAAAAA\r\n", "utf8");

    const out = await readTextWindow({ path, startLine: 1, maxLines: 1, maxLineChars: 3 });

    expect(out.text).toBe("AAA<<<REIFY_LINE_TRUNCATED>>>\r\n");
    expect(out.truncation).toEqual({
      maxLineChars: 3,
      marker: "<<<REIFY_LINE_TRUNCATED>>>",
      lines: [
        {
          line: 1,
          shownChars: 3,
          omittedChars: 3,
          nextStartChar: 3,
          hint: {
            toolRef: `reify:tool/${fsKitImport}#readTextLineWindow`,
            input: { path, line: 1, startChar: 3, maxChars: 3 },
          },
        },
      ],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow truncation does not split surrogate pairs", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-truncation-surrogate");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "ab😀cd\n", "utf8");

    // maxLineChars=3 would split the emoji surrogate pair if we sliced naively.
    const out = await readTextWindow({ path, startLine: 1, maxLines: 1, maxLineChars: 3 });

    expect(out.text).toBe("ab<<<REIFY_LINE_TRUNCATED>>>\n");
    expect(out.truncation).toEqual({
      maxLineChars: 3,
      marker: "<<<REIFY_LINE_TRUNCATED>>>",
      lines: [
        {
          line: 1,
          shownChars: 2,
          omittedChars: 4,
          nextStartChar: 2,
          hint: {
            toolRef: `reify:tool/${fsKitImport}#readTextLineWindow`,
            input: { path, line: 1, startChar: 2, maxChars: 3 },
          },
        },
      ],
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readTextWindow truncation hint stays usable for maxLineChars=1 with emoji", async () => {
  const dir = join(process.cwd(), ".tmp-reify-read-window-hint-emoji");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    await writeFile(path, "😀abc\n", "utf8");

    const out = await readTextWindow({ path, startLine: 1, maxLines: 1, maxLineChars: 1 });
    expect(out.truncation).not.toBeNull();
    expect(out.truncation!.lines.length).toBe(1);

    const hint = out.truncation!.lines[0].hint;
    expect(hint.toolRef).toBe(`reify:tool/${fsKitImport}#readTextLineWindow`);

    // The provided hint should be safe to call even when maxLineChars is too small
    // to return the first astral character without splitting its surrogate pair.
    const chunk = await readTextLineWindow(hint.input);
    expect(chunk.found).toBe(true);
    expect(chunk.text).toBe("😀");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
