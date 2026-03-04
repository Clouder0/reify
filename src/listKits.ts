import type { KitListing } from "./types.js";

import fsKit, { fsKitImport } from "./kits/fs/index.js";
import githubKit, { githubKitImport } from "./kits/github/index.js";

const builtIns: KitListing[] = [
  { name: fsKit.name, summary: fsKit.summary, import: fsKitImport },
  { name: githubKit.name, summary: githubKit.summary, import: githubKitImport },
];

export function listKits(): KitListing[] {
  return builtIns
    .map((e) => ({ ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
