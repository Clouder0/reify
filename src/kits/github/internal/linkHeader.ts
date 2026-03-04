export function parseLinkHeaderPages(
  link: string | null,
): { next?: number; prev?: number; first?: number; last?: number } {
  if (!link) return {};

  const out: { [k: string]: number } = {};
  for (const part of link.split(",")) {
    const urlMatch = /<([^>]+)>/.exec(part);
    const relMatch = /rel="([^"]+)"/.exec(part);
    if (!urlMatch || !relMatch) continue;

    let page: number | null = null;
    try {
      const u = new URL(urlMatch[1]);
      const p = u.searchParams.get("page");
      const n = p ? Number(p) : NaN;
      page = Number.isInteger(n) && n > 0 ? n : null;
    } catch {
      page = null;
    }
    if (!page) continue;

    const rel = relMatch[1];
    if (rel === "next" || rel === "prev" || rel === "first" || rel === "last") {
      out[rel] = page;
    }
  }

  return out as any;
}
