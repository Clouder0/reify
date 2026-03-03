import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import * as fsKit from "../src/kits/fs/index";

function requireEditText(): any {
  const fn = (fsKit as any).editText;
  expect(typeof fn).toBe("function");
  return fn;
}

// ---------------------------------------------------------------------------
// Happy path: unique text, no line constraints
// ---------------------------------------------------------------------------

test("editText replaces unique text in file", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-basic");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello world\ngoodbye world\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "hello world",
      newText: "hi world",
    });

    expect(result.success).toBe(true);
    expect(result.lineChanged).toBe(1);
    expect(typeof result.bytesWritten).toBe("number");

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("hi world\ngoodbye world\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Line-scoped unique: ambiguous text, unique in line range
// ---------------------------------------------------------------------------

test("editText with line scope resolves ambiguous text", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-scoped");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(
      filePath,
      "foo\nbar\nfoo\nbaz\nfoo\n",
      "utf8",
    );

    const editText = requireEditText();
    // "foo" appears 3 times; scope to line 3 to select only the second one
    const result = await editText({
      path: filePath,
      oldText: "foo",
      newText: "qux",
      startLine: 3,
      endLine: 3,
    });

    expect(result.success).toBe(true);
    expect(result.lineChanged).toBe(3);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("foo\nbar\nqux\nbaz\nfoo\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multiple matches global: error with count
// ---------------------------------------------------------------------------

test("editText returns error when oldText matches multiple times globally", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-multi-global");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "aaa\nbbb\naaa\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "aaa",
      newText: "zzz",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OLD_TEXT_NOT_UNIQUE");
    expect(result.matches).toBe(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multiple matches scoped: error with count
// ---------------------------------------------------------------------------

test("editText returns scoped error when oldText matches multiple times in range", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-multi-scoped");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    // 10 lines, "foo" on lines 2, 4, 6, 8
    const lines = [];
    for (let i = 1; i <= 10; i++) {
      lines.push(i % 2 === 0 ? "foo" : `line${i}`);
    }
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "foo",
      newText: "bar",
      startLine: 1,
      endLine: 5,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OLD_TEXT_NOT_UNIQUE_SCOPED");
    expect(result.matches).toBeGreaterThan(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Not found: clear error message
// ---------------------------------------------------------------------------

test("editText returns error when oldText not found", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-notfound");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello world\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "does not exist",
      newText: "replacement",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OLD_TEXT_NOT_FOUND");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// File doesn't exist: structured error
// ---------------------------------------------------------------------------

test("editText returns error for nonexistent file", async () => {
  const editText = requireEditText();
  const result = await editText({
    path: "/nonexistent-path-xyz-123/file.txt",
    oldText: "x",
    newText: "y",
  });

  expect(result.success).toBe(false);
  expect(result.errorCode).toBe("FILE_NOT_FOUND");
});

// ---------------------------------------------------------------------------
// Invalid line range: validation error
// ---------------------------------------------------------------------------

test("editText returns error for invalid line range (endLine < startLine)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-invalid-range");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello\nworld\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "hello",
      newText: "hi",
      startLine: 5,
      endLine: 2,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_LINE_RANGE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Empty oldText: validation error
// ---------------------------------------------------------------------------

test("editText returns error for empty oldText", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-empty-old");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "",
      newText: "something",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OLD_TEXT_EMPTY");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Multi-line replacement: old/new span multiple lines
// ---------------------------------------------------------------------------

test("editText replaces multi-line text", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-multiline");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(
      filePath,
      "line1\nline2\nline3\nline4\nline5\n",
      "utf8",
    );

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "line2\nline3\nline4",
      newText: "replaced2\nreplaced3",
    });

    expect(result.success).toBe(true);
    expect(result.lineChanged).toBe(2);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("line1\nreplaced2\nreplaced3\nline5\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Line ending preservation: \r\n files stay \r\n
// ---------------------------------------------------------------------------

test("editText preserves \\r\\n line endings", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-crlf");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello\r\nworld\r\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "hello",
      newText: "line1\nline2",
    });

    expect(result.success).toBe(true);

    const content = await readFile(filePath, "utf8");
    // newText's \n should be converted to \r\n
    expect(content).toBe("line1\r\nline2\r\nworld\r\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editText preserves \\r line endings", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-cr");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello\rworld\r", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "hello",
      newText: "line1\nline2",
    });

    expect(result.success).toBe(true);

    const content = await readFile(filePath, "utf8");
    // newText's \n should be converted to \r
    expect(content).toBe("line1\rline2\rworld\r");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("editText preserves \\n line endings", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-lf");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "hello\nworld\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "hello",
      newText: "line1\nline2",
    });

    expect(result.success).toBe(true);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("line1\nline2\nworld\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Large file handling
// ---------------------------------------------------------------------------

test("editText handles large files (> 100KB)", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-large");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "large.txt");

    // Generate a file with 5000 lines (~150KB)
    const lines: string[] = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(`line ${i}: ${"x".repeat(20)}`);
    }
    // Put a unique marker at line 2500
    lines[2500] = "UNIQUE_MARKER_FOR_EDIT";
    await writeFile(filePath, lines.join("\n") + "\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "UNIQUE_MARKER_FOR_EDIT",
      newText: "REPLACED_MARKER",
    });

    expect(result.success).toBe(true);
    expect(result.lineChanged).toBe(2501); // 1-based

    const content = await readFile(filePath, "utf8");
    expect(content).toContain("REPLACED_MARKER");
    expect(content).not.toContain("UNIQUE_MARKER_FOR_EDIT");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Path is a directory, not a file
// ---------------------------------------------------------------------------

test("editText returns error when path is a directory", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-dir");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });

    const editText = requireEditText();
    const result = await editText({
      path: dir,
      oldText: "x",
      newText: "y",
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("FILE_NOT_FOUND");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Replacing with empty newText (deletion)
// ---------------------------------------------------------------------------

test("editText can delete text by replacing with empty string", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-delete");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "keep this\nremove this\nkeep too\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "remove this\n",
      newText: "",
    });

    expect(result.success).toBe(true);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("keep this\nkeep too\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Line scope with startLine only (no endLine)
// ---------------------------------------------------------------------------

test("editText with only startLine scopes from that line to end", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-startonly");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "dup\nother\ndup\n", "utf8");

    const editText = requireEditText();
    // "dup" appears on lines 1 and 3; scope from line 3 to select only the second
    const result = await editText({
      path: filePath,
      oldText: "dup",
      newText: "unique",
      startLine: 3,
    });

    expect(result.success).toBe(true);
    expect(result.lineChanged).toBe(3);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("dup\nother\nunique\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// startLine beyond file length
// ---------------------------------------------------------------------------

test("editText returns error when startLine exceeds file length", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-startbeyond");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(filePath, "line1\nline2\n", "utf8");

    const editText = requireEditText();
    const result = await editText({
      path: filePath,
      oldText: "anything",
      newText: "replacement",
      startLine: 100,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_LINE_RANGE");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Smart scope extension catches matches at boundaries
// ---------------------------------------------------------------------------

test("editText smart scope extension catches multi-line match spanning boundary", async () => {
  const dir = join(process.cwd(), ".tmp-reify-editText-extension");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const filePath = join(dir, "file.txt");
    await writeFile(
      filePath,
      "aaa\nbbb\nccc\nddd\neee\n",
      "utf8",
    );

    const editText = requireEditText();
    // oldText spans lines 2-3, scope is line 3 only, but extension should catch it
    const result = await editText({
      path: filePath,
      oldText: "bbb\nccc",
      newText: "xxx\nyyy",
      startLine: 3,
      endLine: 3,
    });

    expect(result.success).toBe(true);
    expect(result.lineChanged).toBe(2);

    const content = await readFile(filePath, "utf8");
    expect(content).toBe("aaa\nxxx\nyyy\nddd\neee\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
