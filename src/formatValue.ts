import { inspect, type InspectOptions } from "node:util";

export type FormatValueOptions = {
  /**
   * Hard cap for output size.
   *
   * Defaults to 20k chars to keep LLM context bounded.
   */
  maxChars?: number;
};

const DEFAULT_MAX_CHARS = 20_000;

const INSPECT_OPTIONS = {
  // Determinism matters for agents (diff/noise reduction).
  sorted: true,

  colors: false,
  getters: false,
  showHidden: false,
  showProxy: false,

  // Keep objects readable but bounded.
  depth: 4,
  maxArrayLength: 100,
  compact: true,
  // Prefer single-line output to minimize whitespace tokens.
  breakLength: Infinity,

  // Preserve built-in human-readable formatting (Buffer, Headers, URLSearchParams, etc.).
  customInspect: true,

  // Don't let util.inspect apply head-only string truncation; we do global middle truncation
  // so tails (often the error) are preserved.
  maxStringLength: null,
} satisfies InspectOptions;

const BUN_WEB_TAGS = new Set([
  "[object Headers]",
  "[object URLSearchParams]",
  "[object Request]",
  "[object Response]",
  "[object FormData]",
  "[object Blob]",
  "[object File]",
]);

function maybeBunInspectWeb(value: unknown): string | null {
  const bun = (globalThis as any).Bun as { inspect?: unknown } | undefined;
  const bunInspect = bun?.inspect;
  if (typeof bunInspect !== "function") return null;

  const tag = Object.prototype.toString.call(value);
  if (!BUN_WEB_TAGS.has(tag)) return null;

  // Bun's Node-compatible util.inspect prints many Web API types as empty (Headers {},
  // Request {}, ...). Bun.inspect retains useful data for these values.
  try {
    return (bunInspect as any)(value, { sorted: true, compact: true });
  } catch {
    return null;
  }
}

function normalizeMaxChars(maxChars: unknown): number {
  if (typeof maxChars !== "number" || !Number.isFinite(maxChars)) {
    return DEFAULT_MAX_CHARS;
  }

  return Math.floor(maxChars);
}

function truncateMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;

  // Marker includes the omitted char count; compute it with a tiny fixpoint loop
  // since the number of digits affects marker length.
  let omitted = Math.max(0, text.length - maxChars);
  let marker = "";

  for (let i = 0; i < 3; i += 1) {
    marker = `... <truncated ${omitted} chars> ...`;
    if (marker.length >= maxChars) {
      return marker.slice(0, maxChars);
    }

    const budget = maxChars - marker.length;
    const nextOmitted = Math.max(0, text.length - budget);
    if (nextOmitted === omitted) break;
    omitted = nextOmitted;
  }

  const budget = maxChars - marker.length;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;

  return text.slice(0, head) + marker + text.slice(text.length - tail);
}

/**
 * Format any JS value into an LLM-friendly display string.
 *
 * - Stable ordering (`sorted: true`) is always enabled.
 * - Output is bounded with middle truncation so tails (errors/log endings) are preserved.
 */
export function formatValue(value: unknown, opts: FormatValueOptions = {}): string {
  const maxChars = normalizeMaxChars(opts.maxChars);
  if (maxChars <= 0) return "";

  try {
    const rendered =
      typeof value === "string"
        ? value
        : maybeBunInspectWeb(value) ?? inspect(value, INSPECT_OPTIONS);
    return truncateMiddle(rendered, maxChars);
  } catch (err) {
    const name = err instanceof Error ? err.name : "Error";
    const message = err instanceof Error ? err.message : String(err);
    return truncateMiddle(`[Uninspectable: ${name}: ${message}]`, maxChars);
  }
}
