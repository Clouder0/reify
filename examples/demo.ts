import { inspectTool, listDocs, listKits, listTools } from "@reify-ai/reify";
import fsKit, { readText } from "@reify-ai/reify/kits/fs";

console.log(listKits());
console.log(listTools(fsKit));
console.log(listDocs(fsKit));
console.log(inspectTool(readText));

const s = await readText({ path: "SKILL.md" });
console.log(s.slice(0, 80));
