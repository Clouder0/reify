import { mapActor } from "./mappers.js";
import { truncateTextMiddle } from "./truncate.js";

const SUPPORTED_EVENT_TYPES = [
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
  "closed",
  "reopened",
  "cross-referenced",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeStateReason(value: unknown): "completed" | "not_planned" | null {
  if (value === "COMPLETED" || value === "completed") return "completed";
  if (value === "NOT_PLANNED" || value === "not_planned") return "not_planned";
  return null;
}

function parseOwnerRepoFromHtmlUrl(htmlUrl: string): string | null {
  try {
    const u = new URL(htmlUrl);
    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  } catch {
    // fall through
  }
  return null;
}

export function normalizeStreamEventTypes(eventTypes?: string[]): string[] {
  // IMPORTANT: treat `eventTypes` as a set but emit in a stable, deterministic order.
  const requested = (eventTypes ?? SUPPORTED_EVENT_TYPES)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);

  const supported = new Set(SUPPORTED_EVENT_TYPES);
  for (const ev of requested) {
    if (!supported.has(ev as any)) {
      throw new TypeError(
        `eventTypes contains unsupported value: ${ev}. Supported: ${SUPPORTED_EVENT_TYPES.join(", ")}`,
      );
    }
  }

  const allow = new Set(requested);
  return SUPPORTED_EVENT_TYPES.filter((t) => allow.has(t));
}

export function mapRestTimelineItemToStreamItem(
  item: unknown,
  ctx: {
    includeComments: boolean;
    includeEvents: boolean;
    allowedEventTypes: ReadonlySet<string>;
    maxCommentBodyChars: number;
  },
):
  | {
      kind: "comment";
      commentId: number;
      url: string;
      author: ReturnType<typeof mapActor>;
      createdAt: string;
      updatedAt: string;
      body: string;
      bodyTruncated: boolean;
    }
  | {
      kind: "event";
      eventType:
        | "labeled"
        | "unlabeled"
        | "assigned"
        | "unassigned"
        | "closed"
        | "reopened"
        | "cross-referenced";
      createdAt: string;
      actor: ReturnType<typeof mapActor>;
      label?: string;
      assignee?: string | null;
      stateReason?: "completed" | "not_planned" | null;
      source?: { kind: "issue" | "pull"; repo: string; number: number; url: string; title: string };
    }
  | null {
  if (!isRecord(item)) return null;

  const eventRaw = asString(item.event);
  const event = eventRaw ? eventRaw.toLowerCase() : null;
  if (!event) return null;

  if (event === "commented") {
    if (!ctx.includeComments) return null;

    const commentId = asNumber(item.id);
    const url = asString(item.html_url) ?? asString(item.url);
    const createdAt = asString(item.created_at);
    const updatedAt = asString(item.updated_at);
    if (!commentId || !url || !createdAt || !updatedAt) return null;

    const bodyRaw = typeof item.body === "string" ? item.body : "";
    const truncated = truncateTextMiddle(bodyRaw, ctx.maxCommentBodyChars);

    const author = mapActor(item.user ?? item.actor);
    return {
      kind: "comment",
      commentId,
      url,
      author,
      createdAt,
      updatedAt,
      body: truncated.text,
      bodyTruncated: truncated.truncated,
    };
  }

  if (!ctx.includeEvents) return null;
  if (!ctx.allowedEventTypes.has(event)) return null;

  const createdAt = asString(item.created_at);
  if (!createdAt) return null;

  if (event === "labeled" || event === "unlabeled") {
    const label = isRecord(item.label) ? asString(item.label.name) : null;
    if (!label) return null;
    return {
      kind: "event",
      eventType: event,
      createdAt,
      actor: mapActor(item.actor),
      label,
    };
  }

  if (event === "assigned" || event === "unassigned") {
    const assignee = isRecord(item.assignee) ? asString(item.assignee.login) : null;
    return {
      kind: "event",
      eventType: event,
      createdAt,
      actor: mapActor(item.actor),
      assignee,
    };
  }

  if (event === "closed") {
    const stateReason = normalizeStateReason(item.state_reason);
    return {
      kind: "event",
      eventType: "closed",
      createdAt,
      actor: mapActor(item.actor),
      stateReason,
    };
  }

  if (event === "reopened") {
    return {
      kind: "event",
      eventType: "reopened",
      createdAt,
      actor: mapActor(item.actor),
    };
  }

  if (event === "cross-referenced") {
    if (!isRecord(item.source) || !isRecord(item.source.issue)) return null;
    const src = item.source.issue;

    const number = asNumber(src.number);
    const url = asString(src.html_url) ?? asString(src.url);
    const title = asString(src.title);
    if (!number || !url || !title) return null;

    const repo = parseOwnerRepoFromHtmlUrl(url);
    if (!repo) return null;

    const kind = isRecord(src.pull_request) ? ("pull" as const) : ("issue" as const);

    return {
      kind: "event",
      eventType: "cross-referenced",
      createdAt,
      actor: mapActor(item.actor),
      source: {
        kind,
        repo,
        number,
        url,
        title,
      },
    };
  }

  // Any other events are currently unsupported.
  return null;
}
