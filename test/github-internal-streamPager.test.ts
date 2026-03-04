import { expect, test } from "bun:test";

import { collectStreamItemsFromPages } from "../src/kits/github/internal/streamPager";

test("collectStreamItemsFromPages (asc) resumes mid-page via next cursor", async () => {
  const pages: Record<number, unknown[]> = {
    1: [1, 2, 3],
    2: [4, 5, 6],
  };

  const fetchPage = async (page: number) => ({
    items: pages[page] ?? [],
    hasMore: page < 2,
  });

  const mapItem = (v: unknown) => (typeof v === "number" ? { v } : null);

  const page1 = await collectStreamItemsFromPages({
    order: "asc",
    limit: 4,
    start: { page: 1, index: 0 },
    fetchPage,
    mapItem,
    maxPagesPerCall: 10,
  });

  expect(page1.items).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }, { v: 4 }]);
  expect(page1.next).toEqual({ page: 2, index: 1 });

  const page2 = await collectStreamItemsFromPages({
    order: "asc",
    limit: 10,
    start: page1.next!,
    fetchPage,
    mapItem,
    maxPagesPerCall: 10,
  });

  expect(page2.items).toEqual([{ v: 5 }, { v: 6 }]);
  expect(page2.next).toBeUndefined();
});

test("collectStreamItemsFromPages advances past skipped items (null mappings)", async () => {
  const pages: Record<number, unknown[]> = {
    1: [1, 2, 3, 4],
    2: [5],
  };

  const fetchPage = async (page: number) => ({
    items: pages[page] ?? [],
    hasMore: page < 2,
  });

  // Keep only odd numbers.
  const mapItem = (v: unknown) => (typeof v === "number" && v % 2 === 1 ? { v } : null);

  const out = await collectStreamItemsFromPages({
    order: "asc",
    limit: 10,
    start: { page: 1, index: 0 },
    fetchPage,
    mapItem,
    maxPagesPerCall: 10,
  });

  expect(out.items).toEqual([{ v: 1 }, { v: 3 }, { v: 5 }]);
  expect(out.next).toBeUndefined();
});

test("collectStreamItemsFromPages (desc) reverses within pages and decrements page", async () => {
  const pages: Record<number, unknown[]> = {
    1: [1, 2, 3],
    2: [4, 5, 6],
  };

  const fetchPage = async (page: number) => ({
    items: pages[page] ?? [],
    hasMore: page > 1,
  });

  const mapItem = (v: unknown) => (typeof v === "number" ? { v } : null);

  const out = await collectStreamItemsFromPages({
    order: "desc",
    limit: 4,
    start: { page: 2, index: 0 },
    fetchPage,
    mapItem,
    maxPagesPerCall: 10,
  });

  expect(out.items).toEqual([{ v: 6 }, { v: 5 }, { v: 4 }, { v: 3 }]);
  expect(out.next).toEqual({ page: 1, index: 1 });
});

test("collectStreamItemsFromPages respects maxPagesPerCall and still makes progress", async () => {
  const pages: Record<number, unknown[]> = {
    1: [0],
    2: [0],
    3: [1],
  };

  const fetchPage = async (page: number) => ({
    items: pages[page] ?? [],
    hasMore: page < 3,
  });

  const mapItem = (v: unknown) => (v === 1 ? { v } : null);

  const out = await collectStreamItemsFromPages({
    order: "asc",
    limit: 1,
    start: { page: 1, index: 0 },
    fetchPage,
    mapItem,
    maxPagesPerCall: 2,
  });

  expect(out.items).toEqual([]);
  expect(out.next).toEqual({ page: 3, index: 0 });
});
