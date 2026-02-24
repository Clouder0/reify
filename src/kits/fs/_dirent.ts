import type { Dirent } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";

export type DirentKind = "skip" | "dir" | "file";

export type DirentLike = Pick<Dirent, "name" | "isDirectory" | "isFile" | "isSymbolicLink">;

type StatLike = {
  isSymbolicLink(): boolean;
  isDirectory(): boolean;
};

export type LstatFn = (path: string) => Promise<StatLike>;

export async function classifyDirent(
  parentFullPath: string,
  entry: DirentLike,
  lstatFn: LstatFn = lstat,
): Promise<DirentKind> {
  if (entry.isSymbolicLink()) return "skip";
  if (entry.isDirectory()) return "dir";
  if (entry.isFile()) return "file";

  // Some filesystems return DT_UNKNOWN for readdir() entries; fall back to lstat()
  // to preserve "skip symlinks" and "directories first" behavior.
  try {
    const st = await lstatFn(join(parentFullPath, entry.name));
    if (st.isSymbolicLink()) return "skip";
    if (st.isDirectory()) return "dir";
  } catch {
    // If we can't stat it, treat as a file-like entry to avoid recursion.
  }

  return "file";
}
