export type GithubErrorContext = {
  operation: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactSecrets(text: string): string {
  return text
    .replace(/ghp_[A-Za-z0-9]{36,}/g, "ghp_[REDACTED]")
    .replace(/gho_[A-Za-z0-9]{20,}/g, "gho_[REDACTED]")
    .replace(/ghu_[A-Za-z0-9]{20,}/g, "ghu_[REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, "github_pat_[REDACTED]")
    .replace(/ghs_[A-Za-z0-9]{20,}/g, "ghs_[REDACTED]")
    .replace(/ghr_[A-Za-z0-9]{20,}/g, "ghr_[REDACTED]");
}

function extractStatus(err: unknown): number | null {
  if (!isRecord(err)) return null;
  const status = err.status;
  return typeof status === "number" && Number.isFinite(status) ? status : null;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (isRecord(err) && typeof err.message === "string") return err.message;
  return String(err);
}

export function toGithubError(err: unknown, ctx: GithubErrorContext): Error {
  const status = extractStatus(err);
  const message = redactSecrets(extractMessage(err));

  const prefix = status ? `${ctx.operation} failed (status ${status})` : `${ctx.operation} failed`;
  let full = message ? `${prefix}: ${message}` : prefix;

  const lower = message.toLowerCase();
  if ((status === 403 || status === 429) && lower.includes("rate limit")) {
    full +=
      "\n\nTip: authenticate with `gh auth login` (recommended) or set `GITHUB_TOKEN`/`GH_TOKEN` (or pass `authToken`).";
  }

  return new Error(full, { cause: err });
}
