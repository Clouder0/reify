import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import fsKit, { fsKitImport } from "../src/kits/fs/index";
import githubKit, { githubKitImport } from "../src/kits/github/index";
import { listKits } from "../src/listKits";

type ReifyLink = { kind: "tool" | "doc"; kitImport: string; target: string };

function extractReifyLinks(markdown: string): ReifyLink[] {
  const out: ReifyLink[] = [];
  const re = /reify:(tool|doc)\/([^\s#`]+)#([^\s)`]+)/g;

  for (const match of markdown.matchAll(re)) {
    out.push({
      kind: match[1] as "tool" | "doc",
      kitImport: match[2],
      target: match[3],
    });
  }

  return out;
}

test("listKits() is aligned with fs kit object", () => {
  const kits = listKits();
  expect(kits.some((k) => k.name === fsKit.name)).toBe(true);

  const fs = kits.find((k) => k.name === fsKit.name);
  expect(fs).toEqual({
    name: fsKit.name,
    summary: fsKit.summary,
    import: fsKitImport,
  });
});

test("fs docs use fully-qualified links that resolve within the kit", () => {
  const pages = Object.values(fsKit.docs);
  const links = pages.flatMap((p) => extractReifyLinks(p.doc));

  expect(links.length).toBeGreaterThan(0);

  for (const link of links) {
    expect(link.kitImport).toBe(fsKitImport);

    if (link.kind === "tool") {
      expect(link.target in fsKit.tools).toBe(true);
    } else {
      expect(link.target in fsKit.docs).toBe(true);
    }
  }
});

test("github docs use fully-qualified links that resolve within the kit", () => {
  const pages = Object.values(githubKit.docs);
  const links = pages.flatMap((p) => extractReifyLinks(p.doc));

  expect(links.length).toBeGreaterThan(0);

  for (const link of links) {
    expect(link.kitImport).toBe(githubKitImport);

    if (link.kind === "tool") {
      expect(link.target in githubKit.tools).toBe(true);
    } else {
      expect(link.target in githubKit.docs).toBe(true);
    }
  }
});

test("every listKits() entry has a package exports subpath", async () => {
  const pkgText = await readFile(resolve(process.cwd(), "package.json"), "utf8");
  const pkg = JSON.parse(pkgText) as { exports?: Record<string, unknown> };
  const exportsMap = pkg.exports ?? {};

  for (const kit of listKits()) {
    const subpath = `./kits/${kit.name}`;
    expect(exportsMap[subpath]).toBeTruthy();
    expect(kit.import).toBe(`@reify-ai/reify/kits/${kit.name}`);
  }
});
