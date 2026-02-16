import type { Kit, ToolListItem } from "./types.js";

export function listTools(kit: Kit): ToolListItem[] {
  return Object.entries(kit.tools)
    .map(([name, tool]) => ({ name, summary: tool.meta.summary }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
