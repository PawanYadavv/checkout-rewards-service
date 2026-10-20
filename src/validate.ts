import { AppError } from "./errors.js";

export const MAX_QUANTITY = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Postgres throws (-> 500) if a non-UUID is compared to a uuid column, so check first.
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

export function requireQuantity(value: unknown): number {
  // Number.isInteger rejects strings ("2"), decimals (1.5), NaN and missing values.
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > MAX_QUANTITY) {
    throw new AppError(400, "VALIDATION_ERROR", `quantity must be an integer from 1 to ${MAX_QUANTITY}`);
  }
  return value as number;
}

export function requireProductId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AppError(400, "VALIDATION_ERROR", "productId must be a non-empty string");
  }
  return value;
}
