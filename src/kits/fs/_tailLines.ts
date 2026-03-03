import type { FileHandle } from "node:fs/promises";

const TAIL_READ_CHUNK_BYTES = 64 * 1024;

export type TailLineRange = {
  /** Start byte offset of line content (inclusive). */
  startByte: number;

  /** End byte offset of line content (exclusive). */
  endByte: number;

  /** Line ending bytes following the content. */
  eol: "\n" | "\r" | "\r\n" | "";
};

export type CollectTailLineRangesOptions = {
  /**
   * Maximum number of ranges to keep in memory.
   *
   * Defaults to `count` (current behavior).
   */
  keep?: number;
};

export async function collectTailLineRanges(
  fh: FileHandle,
  count: number,
  options: CollectTailLineRangesOptions = {},
): Promise<{ ranges: TailLineRange[]; available: number }> {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError("count must be an integer >= 0");
  }

  const keepRaw = options.keep ?? count;
  if (!Number.isInteger(keepRaw) || keepRaw < 0) {
    throw new TypeError("keep must be an integer >= 0");
  }

  const keepCount = Math.min(count, keepRaw);

  if (count === 0) return { ranges: [], available: 0 };

  const size = (await fh.stat()).size;
  if (size === 0) return { ranges: [], available: 0 };

  // Determine the EOL for the last line and where its content ends.
  let cursor = size;
  let currentEol: TailLineRange["eol"] = "";

  const tailLen = Math.min(2, size);
  const tail = Buffer.allocUnsafe(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);

  const last = tail[tailLen - 1];
  const prev = tailLen >= 2 ? tail[tailLen - 2] : null;

  if (last === 0x0a) {
    if (prev === 0x0d) {
      currentEol = "\r\n";
      cursor = size - 2;
    } else {
      currentEol = "\n";
      cursor = size - 1;
    }
  } else if (last === 0x0d) {
    currentEol = "\r";
    cursor = size - 1;
  }

  let foundLines = 0;
  const kept: TailLineRange[] = [];
  let ringIndex = 0;

  const keepRange = (range: TailLineRange) => {
    foundLines += 1;

    if (keepCount === 0) return;
    if (kept.length < keepCount) {
      kept.push(range);
      return;
    }

    kept[ringIndex] = range;
    ringIndex = (ringIndex + 1) % keepCount;
  };

  const buf = Buffer.allocUnsafe(TAIL_READ_CHUNK_BYTES);

  let pos = cursor;
  while (foundLines < count && pos > 0) {
    const cursorStart = cursor;

    const readStart = Math.max(0, pos - buf.length);
    const toRead = pos - readStart;
    const { bytesRead } = await fh.read(buf, 0, toRead, readStart);
    if (bytesRead === 0) break;

    let i = bytesRead - 1;
    while (i >= 0 && foundLines < count) {
      const b = buf[i];
      if (b === 0x0a) {
        // LF (maybe CRLF)
        const lfAbs = readStart + i;
        let sepStart = lfAbs;
        let sepEnd = lfAbs + 1;
        let sepEol: TailLineRange["eol"] = "\n";

        if (i > 0 && buf[i - 1] === 0x0d) {
          sepStart = lfAbs - 1;
          sepEnd = lfAbs + 1;
          sepEol = "\r\n";
        } else if (i === 0 && readStart > 0) {
          // CRLF split across chunks; check preceding byte.
          const one = Buffer.allocUnsafe(1);
          const { bytesRead: oneRead } = await fh.read(one, 0, 1, readStart - 1);
          if (oneRead === 1 && one[0] === 0x0d) {
            sepStart = lfAbs - 1;
            sepEnd = lfAbs + 1;
            sepEol = "\r\n";
          }
        }

        keepRange({ startByte: sepEnd, endByte: cursor, eol: currentEol });
        cursor = sepStart;
        currentEol = sepEol;

        if (cursor < readStart) break;
        i = cursor - readStart - 1;
        continue;
      }

      if (b === 0x0d) {
        // CR (not part of CRLF; CRLF is handled when we see the LF).
        const sepStart = readStart + i;
        const sepEnd = sepStart + 1;
        const sepEol: TailLineRange["eol"] = "\r";

        keepRange({ startByte: sepEnd, endByte: cursor, eol: currentEol });
        cursor = sepStart;
        currentEol = sepEol;

        i = cursor - readStart - 1;
        continue;
      }

      i -= 1;
    }

    if (foundLines >= count) break;

    // If we didn't find a separator in this chunk, continue scanning earlier bytes.
    if (cursor === cursorStart) {
      pos = readStart;
    } else {
      pos = cursor;
    }
  }

  if (foundLines < count) {
    keepRange({ startByte: 0, endByte: cursor, eol: currentEol });
  }

  const ranges =
    keepCount === 0 || kept.length < keepCount
      ? kept
      : [...kept.slice(ringIndex), ...kept.slice(0, ringIndex)];

  return { ranges, available: foundLines };
}
