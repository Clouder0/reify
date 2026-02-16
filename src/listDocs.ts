import type { DocListItem, Kit } from "./types.js";

export function listDocs(kit: Kit): DocListItem[] {
  return Object.entries(kit.docs)
    .map(([name, doc]) => ({ name, summary: doc.summary }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
