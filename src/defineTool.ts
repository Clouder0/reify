import type { BaseType } from "arktype";
import type { Tool } from "./types.js";

type ObjectPayload<T> = T extends Record<string, unknown> ? T : never;

function isObjectPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function omitUndefinedShallow(value: Record<string, unknown>): Record<string, unknown> {
  // Fast path: avoid copying unless we find an `undefined`.
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) {
      const out: Record<string, unknown> = { ...value };
      for (const k of Object.keys(out)) {
        if (out[k] === undefined) delete out[k];
      }
      return out;
    }
  }

  return value;
}

export function defineTool<I extends BaseType, O extends BaseType>(def: {
  kit: string;
  name: string;
  summary: string;
  input: I;
  output: O;
  /** Hide from `listTools()` by default (supported-but-unlisted tools). Defaults to `false`. */
  hidden?: boolean;
  validateOutput?: boolean;
  doc?: string;
  fn: (input: ObjectPayload<I["infer"]>) => Promise<O["infer"]> | O["infer"];
}): Tool<I, O> {
  const tool = (async (raw: ObjectPayload<I["inferIn"]>) => {
    if (!isObjectPayload(raw)) {
      throw new TypeError(`Tool ${def.kit}.${def.name} expects a single object input`);
    }

    const sanitized = omitUndefinedShallow(raw);
    const parsed = def.input.assert(sanitized) as ObjectPayload<I["infer"]>;
    const result = await def.fn(parsed);
    if (def.validateOutput) {
      return def.output.assert(result);
    }

    return result;
  }) as Tool<I, O>;

  tool.meta = {
    kit: def.kit,
    name: def.name,
    summary: def.summary,
    input: def.input,
    output: def.output,
    doc: def.doc,
    hidden: def.hidden ?? false,
  };

  return tool;
}
