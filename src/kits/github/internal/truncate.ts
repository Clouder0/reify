export type TruncateResult = {
  text: string;
  truncated: boolean;
};

// Mirror `src/formatValue.ts` middle truncation semantics:
// - preserve tail
// - include omitted count in marker
// - guarantee output length <= maxChars
export function truncateTextMiddle(text: string, maxChars: number): TruncateResult {
  const cap = Number.isFinite(maxChars) ? Math.floor(maxChars) : 0;
  if (cap <= 0) {
    return { text: "", truncated: text.length > 0 };
  }

  if (text.length <= cap) {
    return { text, truncated: false };
  }

  // Marker includes the omitted char count; compute it with a tiny fixpoint loop
  // since the number of digits affects marker length.
  let omitted = Math.max(0, text.length - cap);
  let marker = "";

  for (let i = 0; i < 3; i += 1) {
    marker = `... <truncated ${omitted} chars> ...`;
    if (marker.length >= cap) {
      return { text: marker.slice(0, cap), truncated: true };
    }

    const budget = cap - marker.length;
    const nextOmitted = Math.max(0, text.length - budget);
    if (nextOmitted === omitted) break;
    omitted = nextOmitted;
  }

  const budget = cap - marker.length;
  const head = Math.floor(budget * 0.6);
  const tail = budget - head;

  return {
    text: text.slice(0, head) + marker + text.slice(text.length - tail),
    truncated: true,
  };
}
