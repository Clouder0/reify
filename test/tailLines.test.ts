import { expect, test } from "bun:test";
import { mkdir, open, rm, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";

import { collectTailLineRanges } from "../src/kits/fs/_tailLines";

async function readUtf8Range(fh: FileHandle, startByte: number, endByte: number): Promise<string> {
  const len = endByte - startByte;
  if (len <= 0) return "";
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, startByte);
  expect(bytesRead).toBe(len);
  return buf.toString("utf8");
}

test("collectTailLineRanges supports keep to bound returned ranges", async () => {
  const dir = join(process.cwd(), ".tmp-reify-tail-lines-keep");
  await rm(dir, { recursive: true, force: true });
  try {
    await mkdir(dir, { recursive: true });
    const path = join(dir, "sample.txt");
    const text = Array.from({ length: 10 }, (_, i) => `line-${i + 1}\n`).join("");
    await writeFile(path, text, "utf8");

    const fh = await open(path, "r");
    try {
      // keep=2 should force an O(2) ranges array even though count=10.
      const out = await collectTailLineRanges(fh, 10, { keep: 2 });
      expect(out.available).toBe(10);
      expect(out.ranges.length).toBe(2);

      const a = out.ranges[0];
      const b = out.ranges[1];
      expect(a.eol).toBe("\n");
      expect(b.eol).toBe("\n");

      expect(await readUtf8Range(fh, a.startByte, a.endByte)).toBe("line-2");
      expect(await readUtf8Range(fh, b.startByte, b.endByte)).toBe("line-1");
    } finally {
      await fh.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
