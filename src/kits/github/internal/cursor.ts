type CursorPayload<T> = {
  v: 1;
  sig: string;
  data: T;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function encodeCursor<T>(sig: string, data: T): string {
  const payload: CursorPayload<T> = { v: 1, sig, data };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeCursor<T>(cursor: string, expectedSig: string): CursorPayload<T> {
  let raw: string;
  try {
    raw = Buffer.from(cursor, "base64url").toString("utf8");
  } catch {
    throw new TypeError("Invalid cursor encoding");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TypeError("Invalid cursor JSON");
  }

  if (!isRecord(parsed)) {
    throw new TypeError("Invalid cursor payload");
  }

  if (parsed.v !== 1) {
    throw new TypeError("Invalid cursor version");
  }

  if (typeof parsed.sig !== "string") {
    throw new TypeError("Invalid cursor signature");
  }

  if (parsed.sig !== expectedSig) {
    throw new Error("cursor mismatch; restart without cursor");
  }

  return parsed as CursorPayload<T>;
}
