import { expect, test } from "bun:test";

import { LineScanner } from "../src/kits/fs/_lineScanner";

function scanChunks(chunks: string[]): string[] {
  const out: string[] = [];
  let current = "";
  const scanner = new LineScanner();

  const sink = {
    onContent: (segment: string) => {
      current += segment;
    },
    onLineEnd: (eol: string) => {
      out.push(`${current}${eol}`);
      current = "";
    },
  };

  for (const chunk of chunks) {
    scanner.write(chunk, sink);
  }
  scanner.end(sink);

  return out;
}

test("LineScanner preserves LF and final unterminated line", () => {
  expect(scanChunks(["a\nb"])) .toEqual(["a\n", "b"]);
});

test("LineScanner preserves CRLF across chunk boundaries", () => {
  expect(scanChunks(["a\r", "\nb\r", "\n"])) .toEqual(["a\r\n", "b\r\n"]);
});

test("LineScanner preserves CR at EOF", () => {
  expect(scanChunks(["a\r"])) .toEqual(["a\r"]);
});

test("LineScanner does not create an extra line for trailing newline", () => {
  expect(scanChunks(["a\n"])) .toEqual(["a\n"]);
});

test("LineScanner emits empty line for leading newline", () => {
  expect(scanChunks(["\n"])) .toEqual(["\n"]);
});

test("LineScanner emits no lines for empty input", () => {
  expect(scanChunks([])) .toEqual([]);
});
