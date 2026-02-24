import type { BaseType } from "arktype";

type ObjectPayload<T> = T extends Record<string, unknown> ? T : never;

export type ToolMeta<I extends BaseType, O extends BaseType> = {
  kit: string;
  name: string;
  summary: string;
  input: I;
  output: O;
  doc?: string;
  /** Hide from `listTools()` by default (supported-but-unlisted tools). Defaults to `false`. */
  hidden: boolean;
};

export type Tool<I extends BaseType, O extends BaseType> =
  ((input: ObjectPayload<I["inferIn"]>) => Promise<O["infer"]>) & {
    meta: ToolMeta<I, O>;
  };

// Used for kit tool tables and inspection helpers. Tool call signatures vary by schema,
// so we intentionally erase them here.
export type AnyTool = Tool<any, any>;

export type KitDoc = {
  summary: string;
  doc: string; // markdown
};

export type Kit = {
  name: string;
  summary: string;
  docs: Record<string, KitDoc>;
  tools: Record<string, AnyTool>;
};

// `listKits()` returns a stable, copy/pasteable import string.
export type KitListing = {
  name: string;
  summary: string;
  import: string;
};

export type ToolListItem = {
  name: string;
  summary: string;
};

export type DocListItem = {
  name: string;
  summary: string;
};
