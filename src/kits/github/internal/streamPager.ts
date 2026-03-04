export async function collectStreamItemsFromPages(opts: {
  order: "asc" | "desc";
  limit: number;
  start: { page: number; index: number };
  fetchPage: (page: number) => Promise<{ items: unknown[]; hasMore: boolean }>;
  mapItem: (item: unknown) => any | null;
  maxPagesPerCall: number;
}): Promise<{ items: any[]; next?: { page: number; index: number } }> {
  if (!Number.isInteger(opts.limit) || opts.limit < 0) {
    throw new TypeError("limit must be a non-negative integer");
  }
  if (!Number.isInteger(opts.maxPagesPerCall) || opts.maxPagesPerCall < 1) {
    throw new TypeError("maxPagesPerCall must be a positive integer");
  }

  const step = opts.order === "asc" ? 1 : -1;

  let page = opts.start.page;
  let index = opts.start.index;

  const out: any[] = [];

  let pagesFetched = 0;
  let exhausted = false;

  while (out.length < opts.limit && pagesFetched < opts.maxPagesPerCall) {
    const res = await opts.fetchPage(page);
    pagesFetched++;

    const rawItems: unknown[] = Array.isArray(res.items) ? res.items : [];
    const pageItems = opts.order === "asc" ? rawItems : rawItems.slice().reverse();

    // Clamp index so stale cursors (timeline changed) don't blow up.
    if (!Number.isInteger(index) || index < 0) index = 0;
    if (index > pageItems.length) index = pageItems.length;

    for (let i = index; i < pageItems.length; i++) {
      const mapped = opts.mapItem(pageItems[i]);
      index = i + 1;

      if (mapped !== null) {
        out.push(mapped);
        if (out.length >= opts.limit) {
          // If we stopped mid-page, resume within this page. If we stopped exactly at the
          // end, jump to the next/prev page to avoid an extra fetch on the next call.
          if (index < pageItems.length) {
            return { items: out, next: { page, index } };
          }

          if (res.hasMore) {
            return { items: out, next: { page: page + step, index: 0 } };
          }

          return { items: out };
        }
      }
    }

    // Finished scanning this page.
    if (res.hasMore) {
      page = page + step;
      index = 0;
      continue;
    }

    exhausted = true;
    break;
  }

  if (exhausted) {
    return { items: out };
  }

  // We hit the per-call page cap; return a cursor that continues scanning.
  return { items: out, next: { page, index } };
}
