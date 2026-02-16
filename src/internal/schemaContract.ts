export type SchemaContract = {
  expression: string;
  description: string;
  assert: (data: unknown) => unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function isSchemaContract(value: unknown): value is SchemaContract {
  if (!isRecord(value)) return false;
  return (
    typeof value.expression === "string" &&
    typeof value.description === "string" &&
    typeof value.assert === "function"
  );
}
