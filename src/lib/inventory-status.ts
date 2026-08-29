/**
 * Stock status is DERIVED from quantity / reserved / reorderPoint — never stored.
 * Pure functions, safe to import from server, client or edge code.
 *
 *   available          = quantity - reserved
 *   available <= 0                      -> OUT_OF_STOCK
 *   0 < available <= reorderPoint       -> LOW_STOCK
 *   available >  reorderPoint           -> IN_STOCK
 */

export type StockStatus = "IN_STOCK" | "LOW_STOCK" | "OUT_OF_STOCK";

export function stockStatusFromAvailable(
  available: number,
  reorderPoint: number,
): StockStatus {
  if (available <= 0) return "OUT_OF_STOCK";
  if (available <= Math.max(0, reorderPoint)) return "LOW_STOCK";
  return "IN_STOCK";
}

export function stockStatus(
  quantity: number,
  reserved: number,
  reorderPoint: number,
): StockStatus {
  return stockStatusFromAvailable(quantity - reserved, reorderPoint);
}

/** Roll several variant statuses up to a single product-level status. */
export function rollupStatus(statuses: StockStatus[]): StockStatus {
  if (statuses.length === 0) return "OUT_OF_STOCK";
  if (statuses.includes("IN_STOCK")) return "IN_STOCK";
  if (statuses.includes("LOW_STOCK")) return "LOW_STOCK";
  return "OUT_OF_STOCK";
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  IN_STOCK: "In stock",
  LOW_STOCK: "Low stock",
  OUT_OF_STOCK: "Out of stock",
};

/**
 * Reasons an admin can attach to a manual stock adjustment. Open-ended by
 * design — `Inventory.reason` is a plain string, so more can be added here (or
 * used by future automated flows, e.g. "SALE") with no migration.
 */
export const ADJUSTMENT_REASONS = [
  "RESTOCK",
  "MANUAL_ADJUSTMENT",
  "DAMAGE",
  "LOSS",
  "RETURN",
  "CORRECTION",
  "INITIAL_STOCK",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export const ADJUSTMENT_REASON_LABEL: Record<string, string> = {
  RESTOCK: "Restock",
  MANUAL_ADJUSTMENT: "Manual adjustment",
  DAMAGE: "Damage",
  LOSS: "Loss",
  RETURN: "Return",
  CORRECTION: "Correction",
  INITIAL_STOCK: "Initial stock",
  SALE: "Sale",
};
