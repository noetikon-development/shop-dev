/**
 * Pure seller-commission-rate resolver (Phase 9F-39B).
 *
 * Client-safe — no `server-only`, no Prisma. Determines the commission rate
 * (integer BASIS POINTS) to apply when creating a NEW order for a seller.
 *
 *   FIRST_PARTY (Axiaro)  → ALWAYS 0. Can never inherit a non-zero rate.
 *   THIRD_PARTY           → the seller's own stored `Seller.commissionRate`
 *                           (the explicit per-seller rate an admin sets, seeded
 *                           from the CMS global default at creation time).
 *
 * The CMS global default (`marketplace.defaultCommissionBps`) is NOT applied
 * here in this phase — it only seeds a brand-new seller's rate. `globalBps` is a
 * defensive fallback used solely if a seller row somehow carries no numeric
 * rate; it never overrides an existing `Seller.commissionRate`.
 *
 * NEVER call this against a historical order. The frozen
 * `SellerOrder.commissionRate` / `OrderItem.commissionRate` snapshots are the
 * authoritative record for an order that already exists.
 */
export function resolveSellerCommissionBps(
  seller: { type: string; commissionRate?: number | null },
  globalBps?: number,
): number {
  if (seller.type === "FIRST_PARTY") return 0;
  const own = seller.commissionRate;
  if (typeof own === "number" && Number.isFinite(own)) return own;
  return typeof globalBps === "number" && Number.isFinite(globalBps) ? globalBps : 0;
}
