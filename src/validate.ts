import { AppError } from "./errors.js";

export const MAX_QUANTITY = 100;

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
