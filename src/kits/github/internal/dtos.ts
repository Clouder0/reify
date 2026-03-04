import { type as schema } from "arktype";

export const ActorTypeSchema = schema("'User' | 'Bot' | 'Organization' | 'Unknown'");

export const ActorSchema = schema({
  login: "string",
  url: "string",
  type: ActorTypeSchema,
});

export const ActorOrNullSchema = schema.or(ActorSchema, "null");

export const ThreadKindSchema = schema("'issue' | 'pull'");

export const ThreadStateSchema = schema("'open' | 'closed'");
export const ThreadStateReasonSchema = schema("'completed' | 'not_planned' | null");

export const ThreadCardSchema = schema({
  kind: ThreadKindSchema,
  repo: "string",
  number: "number",
  url: "string",
  title: "string",
  state: ThreadStateSchema,
  "stateReason?": ThreadStateReasonSchema,
  author: ActorOrNullSchema,
  labels: "string[]",
  assignees: "string[]",
  createdAt: "string",
  updatedAt: "string",
  commentsCount: "number",
});

export const ThreadSchema = schema({
  kind: ThreadKindSchema,
  repo: "string",
  number: "number",
  url: "string",
  title: "string",
  state: ThreadStateSchema,
  "stateReason?": ThreadStateReasonSchema,
  author: ActorOrNullSchema,
  labels: "string[]",
  assignees: "string[]",
  createdAt: "string",
  updatedAt: "string",
  commentsCount: "number",
  locked: "boolean",
  body: "string",
  bodyTruncated: "boolean",
});

export const ThreadCommentSchema = schema({
  repo: "string",
  number: "number",
  commentId: "number",
  url: "string",
  author: ActorOrNullSchema,
  createdAt: "string",
  updatedAt: "string",
  body: "string",
  bodyTruncated: "boolean",
});

export const PullRequestReviewCommentSchema = schema({
  repo: "string",
  pullNumber: "number",
  commentId: "number",
  url: "string",
  author: ActorOrNullSchema,
  createdAt: "string",
  updatedAt: "string",
  path: "string",
  line: "number | null",
  side: "string | null",
  "inReplyToId?": "number",
  diffHunk: "string",
  diffHunkTruncated: "boolean",
  body: "string",
  bodyTruncated: "boolean",
});

export const PullRequestReviewCommentListSchema = PullRequestReviewCommentSchema.array();

export const ThreadCardListSchema = ThreadCardSchema.array();

export const StreamThreadItemSchema = schema({
  kind: "'thread'",
  url: "string",
  author: ActorOrNullSchema,
  createdAt: "string",
  body: "string",
  bodyTruncated: "boolean",
});

export const StreamCommentItemSchema = schema({
  kind: "'comment'",
  commentId: "number",
  url: "string",
  author: ActorOrNullSchema,
  createdAt: "string",
  updatedAt: "string",
  body: "string",
  bodyTruncated: "boolean",
});

export const StreamCrossRefSourceSchema = schema({
  kind: "'issue' | 'pull'",
  repo: "string",
  number: "number",
  url: "string",
  title: "string",
});

export const StreamLabeledEventSchema = schema({
  kind: "'event'",
  eventType: "'labeled'",
  createdAt: "string",
  actor: ActorOrNullSchema,
  label: "string",
});

export const StreamUnlabeledEventSchema = schema({
  kind: "'event'",
  eventType: "'unlabeled'",
  createdAt: "string",
  actor: ActorOrNullSchema,
  label: "string",
});

export const StreamAssignedEventSchema = schema({
  kind: "'event'",
  eventType: "'assigned'",
  createdAt: "string",
  actor: ActorOrNullSchema,
  assignee: "string | null",
});

export const StreamUnassignedEventSchema = schema({
  kind: "'event'",
  eventType: "'unassigned'",
  createdAt: "string",
  actor: ActorOrNullSchema,
  assignee: "string | null",
});

export const StreamClosedEventSchema = schema({
  kind: "'event'",
  eventType: "'closed'",
  createdAt: "string",
  actor: ActorOrNullSchema,
  stateReason: ThreadStateReasonSchema,
});

export const StreamReopenedEventSchema = schema({
  kind: "'event'",
  eventType: "'reopened'",
  createdAt: "string",
  actor: ActorOrNullSchema,
});

export const StreamCrossReferencedEventSchema = schema({
  kind: "'event'",
  eventType: "'cross-referenced'",
  createdAt: "string",
  actor: ActorOrNullSchema,
  source: StreamCrossRefSourceSchema,
});

export const StreamEventItemSchema = schema.or(
  StreamLabeledEventSchema,
  StreamUnlabeledEventSchema,
  StreamAssignedEventSchema,
  StreamUnassignedEventSchema,
  StreamClosedEventSchema,
  StreamReopenedEventSchema,
  StreamCrossReferencedEventSchema,
);

export const StreamItemSchema = schema.or(
  StreamThreadItemSchema,
  StreamCommentItemSchema,
  StreamEventItemSchema,
);

export const StreamItemListSchema = StreamItemSchema.array();
