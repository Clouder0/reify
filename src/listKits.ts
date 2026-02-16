import type { KitListing } from "./types.js";

import fsKit, { fsKitImport } from "./kits/fs/index.js";

const builtIns: KitListing[] = [{ name: fsKit.name, summary: fsKit.summary, import: fsKitImport }];

export function listKits(): KitListing[] {
  return builtIns
    .map((e) => ({ ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
