import { createHash } from "node:crypto";

export type SearchThreadsQueryInput = {
  repo: string;
  text?: string;
  state?: "open" | "closed" | "all";
  labels?: string[];
  query?: string;
  kind?: "any" | "issue" | "pull";
};

function quoteGithubSearchValue(value: string): string {
  // GitHub search supports quoted values for qualifiers like label:"good first issue".
  const escaped = value.replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
  return `"${escaped}"`;
}

function sha256Base64Url(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("base64url");
}

export function buildSearchThreadsQuery(input: SearchThreadsQueryInput): {
  executedQuery: string;
  sig: string;
} {
  const repo = input.repo.trim();
  if (repo.length === 0) {
    throw new TypeError("repo must be non-empty");
  }

  const kind = input.kind ?? "any";
  if (kind !== "any" && kind !== "issue" && kind !== "pull") {
    throw new TypeError("kind must be any, issue, or pull");
  }

  const text = input.text?.trim();
  const query = input.query?.trim();
  const state = input.state ?? "open";
  const labels = (input.labels ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  labels.sort((a, b) => a.localeCompare(b));

  const parts: string[] = [`repo:${repo}`];
  if (kind === "issue") parts.push("is:issue");
  else if (kind === "pull") parts.push("is:pr");

  if (state === "open") parts.push("is:open");
  else if (state === "closed") parts.push("is:closed");
  else if (state !== "all") throw new TypeError("state must be open, closed, or all");

  for (const label of labels) {
    parts.push(`label:${quoteGithubSearchValue(label)}`);
  }

  if (text) parts.push(text);
  if (query) parts.push(query);

  const executedQuery = parts.join(" ");

  const sig = sha256Base64Url(
    JSON.stringify({ repo, kind, state, labels, text: text ?? null, query: query ?? null }),
  );

  return { executedQuery, sig };
}
