import type { AnyTool, Kit, KitDoc } from "./types.js";
import { isSchemaContract } from "./internal/schemaContract.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKitDoc(value: unknown): value is KitDoc {
  if (!isRecord(value)) return false;
  return typeof value.summary === "string" && typeof value.doc === "string";
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  if (value.trim().length === 0) {
    throw new Error(`${label} must be non-empty`);
  }
}

function requireTool(value: unknown, label: string): asserts value is AnyTool {
  if (typeof value !== "function") {
    throw new Error(`${label} must be a function`);
  }
  const meta = (value as any).meta as unknown;
  if (!isRecord(meta)) {
    throw new Error(`${label} must have a .meta object`);
  }
  if (typeof meta.kit !== "string" || typeof meta.name !== "string") {
    throw new Error(`${label}.meta must include string kit/name`);
  }
  if (typeof meta.summary !== "string") {
    throw new Error(`${label}.meta.summary must be a string`);
  }
  if (meta.doc !== undefined && typeof meta.doc !== "string") {
    throw new Error(`${label}.meta.doc must be a string when provided`);
  }
  const hidden = (meta as { hidden?: unknown }).hidden;
  if (hidden !== undefined && typeof hidden !== "boolean") {
    throw new Error(`${label}.meta.hidden must be a boolean when provided`);
  }
  if (!isSchemaContract(meta.input) || !isSchemaContract(meta.output)) {
    throw new Error(`${label}.meta must include input/output schema contracts`);
  }
}

/**
 * Define a kit and fail fast if invariants are violated.
 *
 * This is intentionally a tiny runtime validator rather than a heavy framework.
 * It keeps kits as plain objects while ensuring `kit.tools` can't silently drift
 * from tool metadata (which agents rely on).
 */
export function defineKit<const K extends Kit>(kit: K): K {
  requireString(kit.name, "kit.name");
  requireString(kit.summary, "kit.summary");

  if (!isRecord(kit.docs)) {
    throw new Error("kit.docs must be an object map");
  }
  for (const [name, doc] of Object.entries(kit.docs)) {
    if (!isKitDoc(doc)) {
      throw new Error(`Doc entry invalid: ${kit.name}.docs[${JSON.stringify(name)}]`);
    }
  }

  if (!isRecord(kit.tools)) {
    throw new Error("kit.tools must be an object map");
  }

  for (const [key, tool] of Object.entries(kit.tools)) {
    const label = `Tool entry invalid: ${kit.name}.tools[${JSON.stringify(key)}]`;
    requireTool(tool, label);

    const meta = (tool as any).meta as { kit: string; name: string };
    if (meta.kit !== kit.name) {
      throw new Error(`Tool kit mismatch: ${kit.name}.${key} has meta.kit=${meta.kit}`);
    }
    if (meta.name !== key) {
      throw new Error(`Tool name mismatch: ${kit.name}.${key} has meta.name=${meta.name}`);
    }
  }

  return kit;
}
