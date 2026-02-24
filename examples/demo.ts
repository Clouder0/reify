import { inspectTool, listDocs, listKits, listTools } from "@reify-ai/reify";
import fsKit, { readTextWindow } from "@reify-ai/reify/kits/fs";

console.log(listKits());
console.log(listTools(fsKit));
console.log(listDocs(fsKit));
console.log(inspectTool(readTextWindow));

const out = await readTextWindow({ path: "SKILL.md", startLine: 1, maxLines: 50 });
console.log(out.text.slice(0, 80));
