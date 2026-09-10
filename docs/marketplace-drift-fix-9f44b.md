# One-time marketplace state-drift repair (9F-44B)

**Status: NOT APPLIED. Operator review + explicit approval required before running.**
This phase (9F-44B) ships the *detection* (`npm run reconcile:marketplace`) and this
prepared repair. It does **not** run the repair. `scripts/reconcile-marketplace.ts`
grandfathers the two orders below to **WARN**; once the repair is applied, remove them
from `GRANDFATHERED_DRIFT` (in that script) so any recurrence FAILs.

The repair is `scripts/fixups/9f44b-sellerorder-drift.sql`. Apply it exactly as the
existing migrations are applied:

```
node --env-file=.env scripts/apply-sql.mjs scripts/fixups/9f44b-sellerorder-drift.sql
```

It is a single `BEGIN … COMMIT`, touches **exactly two `SellerOrder` rows**, is
idempotent (each `UPDATE` is guarded on the current wrong status), writes **no**
`OrderEvent`, **no** `AdminAuditLog`, **no** inventory adjustment, and changes **no**
commission / settlement / payment / `Order` field. Both rows are FIRST_PARTY, so
neither is settlement-relevant.

---

## A. `AX-260904-100255` — CANCELLED parent, SellerOrder still `PENDING_PAYMENT`

| | value |
|---|---|
| Order | `AX-260904-100255` · `Order.status = CANCELLED` (cancelled 2026-09-04 02:44, ~1.5 h after placement) |
| SellerOrder | `cmtm9ffbk0006l104s5dp9xf5` · FIRST_PARTY · `status = PENDING_PAYMENT` · `commissionAmount = 0` · `settlementStatus = PENDING_CAPTURE` · `settlementId = null` |
| Item | "Daily Cast-Iron Pan 26 cm" ×1, offer `cmtkpnfvp007qkgq0f78i21ro` |

**Why it drifted:** the order was cancelled before the cancellation → SellerOrder
status cascade existed (`orders/cancellation.ts` step 3b / `order-actions.ts`
`cancelOrderAction`). The cancellation *did* reverse inventory — the offer's
`OfferAdjustment` ledger shows `SALE −1 @01:13 (Order AX-260904-100255)` then
`CANCELLATION +1 @02:44 (Order AX-260904-100255 cancelled)`, net 0 — it only missed
the `SellerOrder.status` flip.

**Correct state:** `SellerOrder.status = CANCELLED` (what the cancellation cascade
produces today). `commissionAmount` is already `0`. **No inventory action** — already
reversed. **No settlement action** — `PENDING_CAPTURE` / `settlementId null` is
already correct and a CANCELLED FIRST_PARTY SellerOrder is never settled.

```sql
UPDATE "SellerOrder"
   SET "status" = 'CANCELLED', "updatedAt" = now()
 WHERE "id" = 'cmtm9ffbk0006l104s5dp9xf5'
   AND "status" = 'PENDING_PAYMENT'
   AND "orderId" = (SELECT "id" FROM "Order" WHERE "orderNumber" = 'AX-260904-100255' AND "status" = 'CANCELLED');
```

---

## B. `AX-260902-100023` — PROCESSING parent, 1P SellerOrder still `PENDING_PAYMENT`

| | value |
|---|---|
| Order | `AX-260902-100023` · `Order.status = PROCESSING` (confirmed 2026-09-05 05:15 via `confirmOrderAction`) |
| SellerOrder | `cmtlgqob80005kgasosx6x4gv` · FIRST_PARTY · `status = PENDING_PAYMENT` · `commissionAmount = 0` · `settlementStatus = PENDING_CAPTURE` · `settlementId = null` |
| Item | "Commute Roll-Top Backpack" ×1, offer `cmtkpnor00108kgq0h5l5xubk` |

**Why it drifted:** `confirmOrderAction` moved the parent `PENDING_PAYMENT → PROCESSING`
on 2026-09-05, but the 9F-35B assisted-acceptance cascade
(`cascadeSellerOrderFromParent`) was not added to `confirmOrderAction` until 9F-35B
(commit `ea746f0`, 2026-09-09). The parent advanced; the 1P shadow SellerOrder was
left behind.

**Correct state:** `SellerOrder.status = PROCESSING` — exactly what
`cascadeSellerOrderFromParent({ parentStatus: "PROCESSING" })` produces for a
strictly-behind row: a status-guarded forward hop, no Shipment (Shipments are only
created for a THIRD_PARTY SHIPPED cascade), no commission / settlement / inventory
change. The item's sale is recorded in the frozen legacy `Inventory` archive
(`InventoryAdjustment SALE −1 @2026-09-02 10:54`) — the order is proceeding to
fulfilment, not being reversed, so **no inventory action**.

```sql
UPDATE "SellerOrder"
   SET "status" = 'PROCESSING', "updatedAt" = now()
 WHERE "id" = 'cmtlgqob80005kgasosx6x4gv'
   AND "status" = 'PENDING_PAYMENT'
   AND "sellerType" = 'FIRST_PARTY'
   AND "orderId" = (SELECT "id" FROM "Order" WHERE "orderNumber" = 'AX-260902-100023' AND "status" = 'PROCESSING');
```

---

## After applying

1. `npm run reconcile:marketplace` → should print `0 warn · 0 fail` once
   `GRANDFATHERED_DRIFT` is emptied.
2. `npm run reconcile:9e3d` and `npm run monitor:9e3d -- --since=2026-09-09` — unchanged
   (the repair touches no inventory).
3. Remove `"AX-260904-100255"` and `"AX-260902-100023"` from `GRANDFATHERED_DRIFT` in
   `scripts/reconcile-marketplace.ts` and from `GRANDFATHERED` in `scripts/test-9f44b.ts`
   (and adjust the `M ·` grandfathered-detection assertion), so a recurrence FAILs.
