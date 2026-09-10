-- ============================================================================
-- One-time repair — 9F-44B marketplace SellerOrder state drift.
--
-- NOT a migration. NOT auto-run. Operator review + explicit approval required.
-- Rationale + full detail: docs/marketplace-drift-fix-9f44b.md
--
-- Apply exactly like a migration:
--   node --env-file=.env scripts/apply-sql.mjs scripts/fixups/9f44b-sellerorder-drift.sql
--
-- Touches EXACTLY two SellerOrder rows (both FIRST_PARTY, neither
-- settlement-relevant). Each UPDATE is status-guarded, so re-running is a no-op.
-- Writes NO OrderEvent, NO AdminAuditLog, NO inventory adjustment. Changes NO
-- commission / settlement / payment / Order field. Idempotent.
--
-- A. AX-260904-100255 — CANCELLED parent, SellerOrder still PENDING_PAYMENT.
--    Cancelled before the cancellation→SellerOrder cascade existed; inventory was
--    already reversed (OfferAdjustment SALE -1 + CANCELLATION +1, net 0).
--    Correct state: SellerOrder.status = CANCELLED.
--
-- B. AX-260902-100023 — PROCESSING parent, 1P SellerOrder still PENDING_PAYMENT.
--    confirmOrderAction advanced the parent 2026-09-05, before 9F-35B (ea746f0,
--    2026-09-09) added the assisted-acceptance cascade to it.
--    Correct state: SellerOrder.status = PROCESSING (what the cascade produces).
-- ============================================================================

BEGIN;

-- A
UPDATE "SellerOrder"
   SET "status" = 'CANCELLED', "updatedAt" = now()
 WHERE "id" = 'cmtm9ffbk0006l104s5dp9xf5'
   AND "status" = 'PENDING_PAYMENT'
   AND "sellerType" = 'FIRST_PARTY'
   AND "orderId" = (
     SELECT "id" FROM "Order"
      WHERE "orderNumber" = 'AX-260904-100255' AND "status" = 'CANCELLED'
   );

-- B
UPDATE "SellerOrder"
   SET "status" = 'PROCESSING', "updatedAt" = now()
 WHERE "id" = 'cmtlgqob80005kgasosx6x4gv'
   AND "status" = 'PENDING_PAYMENT'
   AND "sellerType" = 'FIRST_PARTY'
   AND "orderId" = (
     SELECT "id" FROM "Order"
      WHERE "orderNumber" = 'AX-260902-100023' AND "status" = 'PROCESSING'
   );

COMMIT;
