import { truncateTextMiddle } from "./truncate.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function ensureNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`);
  }
  return value;
}

export function mapActor(user: unknown): { login: string; url: string; type: "User" | "Bot" | "Organization" | "Unknown" } | null {
  if (!isRecord(user)) return null;
  const login = typeof user.login === "string" ? user.login : null;
  if (!login) return null;

  const url =
    typeof user.html_url === "string" && user.html_url.length > 0
      ? user.html_url
      : typeof user.url === "string" && user.url.length > 0
        ? user.url
        : `https://github.com/${login}`;

  const rawType =
    typeof user.type === "string"
      ? user.type
      : typeof user.__typename === "string"
        ? user.__typename
        : "Unknown";
  const type =
    rawType === "User" || rawType === "Bot" || rawType === "Organization" ? rawType : "Unknown";

  return { login, url, type };
}

function mapLabelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];

  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === "string") {
      if (label) names.push(label);
      continue;
    }
    if (isRecord(label) && typeof label.name === "string" && label.name.length > 0) {
      names.push(label.name);
    }
  }

  names.sort((a, b) => a.localeCompare(b));
  return names;
}

function mapAssigneeLogins(assignees: unknown): string[] {
  if (!Array.isArray(assignees)) return [];

  const logins: string[] = [];
  for (const a of assignees) {
    if (isRecord(a) && typeof a.login === "string" && a.login.length > 0) {
      logins.push(a.login);
    }
  }

  logins.sort((a, b) => a.localeCompare(b));
  return logins;
}

function parseIssueNumberFromIssueUrl(issueUrl: string): number {
  const parts = issueUrl.split("/").filter((p) => p.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1] : "";
  const n = Number(last);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("issue_url must end with an issue number");
  }
  return n;
}

function parsePullNumberFromPullRequestUrl(pullRequestUrl: string): number {
  const parts = pullRequestUrl.split("/").filter((p) => p.length > 0);
  const last = parts.length > 0 ? parts[parts.length - 1] : "";
  const n = Number(last);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new TypeError("pull_request_url must end with a pull number");
  }
  return n;
}

function ensureNullableNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return ensureNumber(value, label);
}

function ensureNullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  return ensureString(value, label);
}

export function mapSearchItemToThreadCard(
  item: unknown,
  ctx: { repo: string },
): {
  kind: "issue" | "pull";
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  stateReason?: "completed" | "not_planned" | null;
  author: ReturnType<typeof mapActor>;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
} {
  if (!isRecord(item)) {
    throw new TypeError("search item must be an object");
  }

  const kind = "pull_request" in item ? "pull" : "issue";

  const number = ensureNumber(item.number, "item.number");
  const title = ensureString(item.title, "item.title");
  const url = ensureString(item.html_url, "item.html_url");

  const stateRaw = ensureString(item.state, "item.state");
  if (stateRaw !== "open" && stateRaw !== "closed") {
    throw new TypeError("item.state must be 'open' or 'closed'");
  }

  const createdAt = ensureString(item.created_at, "item.created_at");
  const updatedAt = ensureString(item.updated_at, "item.updated_at");
  const commentsCount = ensureNumber(item.comments, "item.comments");

  const author = mapActor(item.user);
  const labels = mapLabelNames(item.labels);
  const assignees = mapAssigneeLogins(item.assignees);

  const stateReason = item.state_reason;
  const out: any = {
    kind,
    repo: ctx.repo,
    number,
    url,
    title,
    state: stateRaw,
    author,
    labels,
    assignees,
    createdAt,
    updatedAt,
    commentsCount,
  };

  if (stateReason === "completed" || stateReason === "not_planned" || stateReason === null) {
    // Only include when provided by the API; leaving it undefined reduces output noise.
    if (stateReason !== null) {
      out.stateReason = stateReason;
    }
  }

  return out;
}

export function mapRestThreadToThread(
  thread: unknown,
  ctx: { repo: string; maxBodyChars: number },
): {
  kind: "issue" | "pull";
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  stateReason?: "completed" | "not_planned" | null;
  author: ReturnType<typeof mapActor>;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
  locked: boolean;
  body: string;
  bodyTruncated: boolean;
} {
  if (!isRecord(thread)) {
    throw new TypeError("thread payload must be an object");
  }

  const kind = "pull_request" in thread ? "pull" : "issue";

  const number = ensureNumber(thread.number, "thread.number");
  const title = ensureString(thread.title, "thread.title");
  const url = ensureString(thread.html_url, "thread.html_url");

  const stateRaw = ensureString(thread.state, "thread.state");
  if (stateRaw !== "open" && stateRaw !== "closed") {
    throw new TypeError("thread.state must be 'open' or 'closed'");
  }

  const createdAt = ensureString(thread.created_at, "thread.created_at");
  const updatedAt = ensureString(thread.updated_at, "thread.updated_at");
  const commentsCount = ensureNumber(thread.comments, "thread.comments");

  if (typeof thread.locked !== "boolean") {
    throw new TypeError("thread.locked must be a boolean");
  }
  const locked = thread.locked;

  const bodyRaw = typeof thread.body === "string" ? thread.body : "";
  const truncated = truncateTextMiddle(bodyRaw, ctx.maxBodyChars);

  const author = mapActor(thread.user);
  const labels = mapLabelNames(thread.labels);
  const assignees = mapAssigneeLogins(thread.assignees);

  const out: any = {
    kind,
    repo: ctx.repo,
    number,
    url,
    title,
    state: stateRaw,
    author,
    labels,
    assignees,
    createdAt,
    updatedAt,
    commentsCount,
    locked,
    body: truncated.text,
    bodyTruncated: truncated.truncated,
  };

  const stateReason = thread.state_reason;
  if (stateReason === "completed" || stateReason === "not_planned") {
    out.stateReason = stateReason;
  }

  return out;
}

export function mapRestThreadToThreadCard(
  thread: unknown,
  ctx: { repo: string },
): {
  kind: "issue" | "pull";
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  stateReason?: "completed" | "not_planned" | null;
  author: ReturnType<typeof mapActor>;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  commentsCount: number;
} {
  if (!isRecord(thread)) {
    throw new TypeError("thread payload must be an object");
  }

  const kind = "pull_request" in thread ? "pull" : "issue";

  const number = ensureNumber(thread.number, "thread.number");
  const title = ensureString(thread.title, "thread.title");
  const url = ensureString(thread.html_url, "thread.html_url");

  const stateRaw = ensureString(thread.state, "thread.state");
  if (stateRaw !== "open" && stateRaw !== "closed") {
    throw new TypeError("thread.state must be 'open' or 'closed'");
  }

  const createdAt = ensureString(thread.created_at, "thread.created_at");
  const updatedAt = ensureString(thread.updated_at, "thread.updated_at");
  const commentsCount = ensureNumber(thread.comments, "thread.comments");

  const author = mapActor(thread.user);
  const labels = mapLabelNames(thread.labels);
  const assignees = mapAssigneeLogins(thread.assignees);

  const out: any = {
    kind,
    repo: ctx.repo,
    number,
    url,
    title,
    state: stateRaw,
    author,
    labels,
    assignees,
    createdAt,
    updatedAt,
    commentsCount,
  };

  const stateReason = thread.state_reason;
  if (stateReason === "completed" || stateReason === "not_planned") {
    out.stateReason = stateReason;
  }

  return out;
}

export function mapRestIssueCommentToThreadComment(
  comment: unknown,
  ctx: { repo: string; maxBodyChars: number },
): {
  repo: string;
  number: number;
  commentId: number;
  url: string;
  author: ReturnType<typeof mapActor>;
  createdAt: string;
  updatedAt: string;
  body: string;
  bodyTruncated: boolean;
} {
  if (!isRecord(comment)) {
    throw new TypeError("comment payload must be an object");
  }

  const commentId = ensureNumber(comment.id, "comment.id");
  const url = ensureString(comment.html_url, "comment.html_url");
  const createdAt = ensureString(comment.created_at, "comment.created_at");
  const updatedAt = ensureString(comment.updated_at, "comment.updated_at");

  const issueUrl = ensureString(comment.issue_url, "comment.issue_url");
  const number = parseIssueNumberFromIssueUrl(issueUrl);

  const bodyRaw = typeof comment.body === "string" ? comment.body : "";
  const truncated = truncateTextMiddle(bodyRaw, ctx.maxBodyChars);

  return {
    repo: ctx.repo,
    number,
    commentId,
    url,
    author: mapActor(comment.user),
    createdAt,
    updatedAt,
    body: truncated.text,
    bodyTruncated: truncated.truncated,
  };
}

export function mapRestPullRequestReviewCommentToPullRequestReviewComment(
  comment: unknown,
  ctx: { repo: string; pullNumber?: number; maxBodyChars: number; maxDiffHunkChars: number },
): {
  repo: string;
  pullNumber: number;
  commentId: number;
  url: string;
  author: ReturnType<typeof mapActor>;
  createdAt: string;
  updatedAt: string;
  path: string;
  line: number | null;
  side: string | null;
  inReplyToId?: number;
  diffHunk: string;
  diffHunkTruncated: boolean;
  body: string;
  bodyTruncated: boolean;
} {
  if (!isRecord(comment)) {
    throw new TypeError("review comment payload must be an object");
  }

  const commentId = ensureNumber(comment.id, "comment.id");
  const url = ensureString(comment.html_url, "comment.html_url");
  const createdAt = ensureString(comment.created_at, "comment.created_at");
  const updatedAt = ensureString(comment.updated_at, "comment.updated_at");
  const path = ensureString(comment.path, "comment.path");

  const line = ensureNullableNumber(comment.line, "comment.line");
  const side = ensureNullableString(comment.side, "comment.side");

  const inReplyToRaw = comment.in_reply_to_id;
  const inReplyToId =
    typeof inReplyToRaw === "number" && Number.isFinite(inReplyToRaw)
      ? ensureNumber(inReplyToRaw, "comment.in_reply_to_id")
      : undefined;

  const pullRequestUrl = ensureString(comment.pull_request_url, "comment.pull_request_url");
  const payloadPullNumber = parsePullNumberFromPullRequestUrl(pullRequestUrl);

  const pullNumber = ctx.pullNumber ?? payloadPullNumber;
  if (ctx.pullNumber !== undefined && ctx.pullNumber !== payloadPullNumber) {
    throw new TypeError("pullNumber does not match payload pull_request_url");
  }

  const diffHunkRaw = typeof comment.diff_hunk === "string" ? comment.diff_hunk : "";
  const diffHunk = truncateTextMiddle(diffHunkRaw, ctx.maxDiffHunkChars);

  const bodyRaw = typeof comment.body === "string" ? comment.body : "";
  const body = truncateTextMiddle(bodyRaw, ctx.maxBodyChars);

  const out: any = {
    repo: ctx.repo,
    pullNumber,
    commentId,
    url,
    author: mapActor(comment.user),
    createdAt,
    updatedAt,
    path,
    line,
    side,
    diffHunk: diffHunk.text,
    diffHunkTruncated: diffHunk.truncated,
    body: body.text,
    bodyTruncated: body.truncated,
  };

  if (typeof inReplyToId === "number") {
    out.inReplyToId = inReplyToId;
  }

  return out;
}
