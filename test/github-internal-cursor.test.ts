import { expect, test } from "bun:test";

import { decodeCursor, encodeCursor } from "../src/kits/github/internal/cursor";

test("encodeCursor/decodeCursor roundtrip", () => {
  const cursor = encodeCursor("sig1", { page: 2 });
  const decoded = decodeCursor<{ page: number }>(cursor, "sig1");
  expect(decoded).toEqual({ v: 1, sig: "sig1", data: { page: 2 } });
});

test("decodeCursor rejects invalid cursors", () => {
  expect(() => decodeCursor("not-base64", "sig")).toThrow();
});

test("decodeCursor throws a cursor mismatch error when signature differs", () => {
  const cursor = encodeCursor("sig1", { page: 2 });
  expect(() => decodeCursor(cursor, "sig2")).toThrow(/cursor mismatch/i);
});
