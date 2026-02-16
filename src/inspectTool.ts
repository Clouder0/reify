import type { AnyTool } from "./types.js";
import { isSchemaContract } from "./internal/schemaContract.js";

export type InspectedSchema = {
  expression: string;
  description?: string;
};

export type InspectedTool = {
  kit: string;
  name: string;
  summary: string;
  input: InspectedSchema;
  output: InspectedSchema;
  doc?: string;
};

function inspectSchema(schema: { expression: string; description: string }): InspectedSchema {
  const expression = schema.expression;
  const description = schema.description.trim();

  if (!description || description === expression) {
    return { expression };
  }

  return { expression, description };
}

/**
 * Build a readable, JSON-friendly inspection payload for a tool.
 *
 * This intentionally returns stable, schema-level strings for agents.
 */
export function inspectTool(tool: AnyTool): InspectedTool {
  if ((typeof tool !== "object" && typeof tool !== "function") || tool === null) {
    throw new Error("Cannot inspect tool: invalid tool; expected object or function");
  }

  const meta = (tool as { meta?: unknown }).meta;
  if (!meta || typeof meta !== "object") {
    throw new Error("Cannot inspect tool: invalid meta object");
  }

  const metadata = meta as {
    kit?: unknown;
    name?: unknown;
    summary?: unknown;
    input?: unknown;
    output?: unknown;
    doc?: unknown;
  };

  if (typeof metadata.kit !== "string" || typeof metadata.name !== "string") {
    throw new Error("Cannot inspect tool: invalid meta.kit/meta.name; expected strings");
  }

  if (typeof metadata.summary !== "string") {
    throw new Error(
      `Cannot inspect tool ${metadata.kit}.${metadata.name}: meta.summary must be a string`,
    );
  }

  if (metadata.doc !== undefined && typeof metadata.doc !== "string") {
    throw new Error(
      `Cannot inspect tool ${metadata.kit}.${metadata.name}: meta.doc must be undefined or a string`,
    );
  }

  if (!isSchemaContract(metadata.input)) {
    throw new Error(
      `Cannot inspect tool ${metadata.kit}.${metadata.name}: meta.input must be a schema contract`,
    );
  }

  if (!isSchemaContract(metadata.output)) {
    throw new Error(
      `Cannot inspect tool ${metadata.kit}.${metadata.name}: meta.output must be a schema contract`,
    );
  }

  return {
    kit: metadata.kit,
    name: metadata.name,
    summary: metadata.summary,
    input: inspectSchema(metadata.input),
    output: inspectSchema(metadata.output),
    doc: metadata.doc,
  };
}
