/**
 * Phase 9E-3C-1 — historical Order -> SellerOrder backfill.
 *
 * ADDITIVE + REVERSIBLE. Every existing production order is Axiaro-owned, so
 * this gives each one EXACTLY ONE SellerOrder (the FIRST_PARTY seller) and
 * links its OrderItems, copying historical economics VERBATIM.
 *
 * It NEVER:
 *   - rewrites Order.subtotal / shippingFee / discountTotal / grandTotal;
 *   - reconstructs historical pricing from today's Offer / Variant / Product;
 *   - recomputes historical free-shipping qualification;
 *   - invents commission, a Shipment, or an Offer mapping.
 *
 * Per historical OrderItem:
 *   sellerOrderId  -> the new Axiaro SellerOrder
 *   sellerId       -> the Axiaro FIRST_PARTY seller id (plain snapshot string)
 *   offerId        -> the historical 1P Offer, ONLY when the mapping is
 *                     deterministic (exactly one FIRST_PARTY offer for the
 *                     variant); otherwise left NULL and reported
 *   commissionRate -> 0
 *
 * SellerOrder money (9E-3B, integer centavos):
 *   merchandiseSubtotal = Order.subtotal        (authoritative historical value)
 *   discountAllocated   = Order.discountTotal
 *   shippingFee         = Order.shippingFee      (historical actual = seller shipping revenue, O-3)
 *   platformShippingSubsidy = 0
 *   freeShippingApplied = NULL                   (not evaluated for history)
 *   commissionAmount    = 0                      (FIRST_PARTY rate 0)
 *   total               = merchandiseSubtotal - discountAllocated + shippingFee
 *
 * HARD STOP if, for any order:
 *   Order.subtotal - Order.discountTotal + Order.shippingFee != Order.grandTotal
 * (the historical totals must already reconcile; this script does not "fix" them).
 *
 * Also ensures the `marketplace.multiSellerCheckout` StoreSetting row exists and
 * is "false" (created only if absent — never overwritten). The row is NOT
 * registered in SETTINGS_REGISTRY, so nothing reads it yet.
 *
 * Idempotent: an order that already has a SellerOrder is skipped.
 *
 * Run:      npm run db:backfill:9e3c1
 * Preview:  npm run db:backfill:9e3c1 -- --dry-run
 * Revert:   npm run db:backfill:9e3c1 -- --revert
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({
  datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
});

const DRY_RUN = process.argv.includes("--dry-run");
const REVERT = process.argv.includes("--revert");

/** Round to the nearest integer; a .5 rounds away from zero (9E-3B §15). */
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

/** 9E-3B §3 commission formula. Axiaro FIRST_PARTY rate is 0 -> always 0. */
function commissionFor(merchandiseSubtotal: number, commissionRateBps: number): number {
  return roundHalfUp((merchandiseSubtotal * commissionRateBps) / 10000);
}

/** Historical Order.status -> SellerOrder.status (9E-3B §7 vocabulary). */
function mapSellerOrderStatus(orderStatus: string): string {
  switch (orderStatus) {
    case "PENDING_PAYMENT":
      return "PENDING_PAYMENT";
    case "PENDING":
    case "PAID":
    case "PROCESSING":
      return "PROCESSING";
    case "SHIPPED":
    case "OUT_FOR_DELIVERY":
      return "SHIPPED";
    case "DELIVERED":
      return "DELIVERED";
    case "CANCELLED":
      return "CANCELLED";
    default:
      return "PENDING_PAYMENT";
  }
}

/** Historical Order.paymentStatus -> SellerOrder.settlementStatus. */
function mapSettlementStatus(paymentStatus: string): string {
  if (paymentStatus === "PAID") return "CAPTURED";
  if (paymentStatus === "REFUNDED") return "REFUNDED";
  return "PENDING_CAPTURE";
}

async function main() {
  console.log(
    `PHASE 9E-3C-1 — historical Order -> SellerOrder backfill  ${DRY_RUN ? "(DRY RUN)" : REVERT ? "(REVERT)" : ""}\n`,
  );

  if (REVERT) return revert();

  const axiaro = await prisma.seller.findFirst({
    where: { type: "FIRST_PARTY" },
    select: { id: true, displayName: true, type: true, supportEmail: true, commissionRate: true },
  });
  if (!axiaro) {
    console.error("STOP — no FIRST_PARTY (Axiaro) seller found. Run db:backfill:marketplace first.");
    process.exitCode = 1;
    return;
  }
  if (axiaro.commissionRate !== 0) {
    console.error(`STOP — FIRST_PARTY seller commissionRate is ${axiaro.commissionRate}, expected 0.`);
    process.exitCode = 1;
    return;
  }
  console.log(`  Axiaro FIRST_PARTY seller: ${axiaro.id} (${axiaro.displayName})\n`);

  // --- marketplace.multiSellerCheckout setting (create only if absent) ------
  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  if (!gate) {
    console.log(`  marketplace.multiSellerCheckout: absent -> ${DRY_RUN ? "would create" : "creating"} = "false"`);
    if (!DRY_RUN) {
      await prisma.storeSetting.create({
        data: {
          key: "marketplace.multiSellerCheckout",
          value: "false",
          type: "boolean",
          label: "Multi-seller checkout enabled",
          group: "general",
        },
      });
    }
  } else {
    console.log(`  marketplace.multiSellerCheckout: present = "${gate.value}" (left untouched)`);
  }
  console.log();

  const orders = await prisma.order.findMany({
    orderBy: { placedAt: "asc" },
    include: { items: { orderBy: { id: "asc" } }, sellerOrders: { select: { id: true } } },
  });

  let created = 0;
  let skipped = 0;
  let itemsLinked = 0;
  let itemsWithoutOffer = 0;
  const reconcileFailures: string[] = [];
  const exceptions: string[] = [];

  for (const order of orders) {
    if (order.sellerOrders.length > 0) {
      skipped++;
      console.log(`  ${order.orderNumber}: already has ${order.sellerOrders.length} SellerOrder — skipped`);
      continue;
    }

    // HARD STOP: historical totals must already reconcile.
    const reconciled = order.subtotal - order.discountTotal + order.shippingFee;
    if (reconciled !== order.grandTotal) {
      reconcileFailures.push(
        `${order.orderNumber}: subtotal ${order.subtotal} - discount ${order.discountTotal} + shipping ${order.shippingFee} = ${reconciled}, but grandTotal = ${order.grandTotal}`,
      );
      continue;
    }

    // Sanity: Σ line totals vs subtotal (reported, not fatal — subtotal is authoritative).
    const lineSum = order.items.reduce((n, it) => n + it.lineTotal, 0);
    if (lineSum !== order.subtotal) {
      exceptions.push(
        `${order.orderNumber}: Σ OrderItem.lineTotal ${lineSum} != Order.subtotal ${order.subtotal} (subtotal kept as merchandiseSubtotal)`,
      );
    }

    const merchandiseSubtotal = order.subtotal;
    const discountAllocated = order.discountTotal;
    const shippingFee = order.shippingFee;
    const total = merchandiseSubtotal - discountAllocated + shippingFee; // == grandTotal (checked above)
    const commissionRate = 0; // Axiaro FIRST_PARTY
    const commissionAmount = commissionFor(merchandiseSubtotal, commissionRate); // -> 0
    const status = mapSellerOrderStatus(order.status);
    const settlementStatus = mapSettlementStatus(order.paymentStatus);

    // Resolve a deterministic 1P offer per item.
    const itemOfferIds = new Map<string, string | null>();
    for (const it of order.items) {
      if (!it.variantId) {
        itemOfferIds.set(it.id, null);
        exceptions.push(`${order.orderNumber} / item ${it.id} (${it.name}): NULL variantId — offerId left NULL`);
        itemsWithoutOffer++;
        continue;
      }
      const offers = await prisma.offer.findMany({
        where: { variantId: it.variantId, sellerId: axiaro.id },
        select: { id: true, condition: true, price: true },
      });
      if (offers.length === 1) {
        itemOfferIds.set(it.id, offers[0].id);
        if (offers[0].price !== it.unitPrice) {
          exceptions.push(
            `${order.orderNumber} / item ${it.id} (${it.name}): historical unitPrice ${it.unitPrice} != current 1P Offer.price ${offers[0].price} — offerId still linked (historical unitPrice preserved, NOT overwritten)`,
          );
        }
      } else {
        itemOfferIds.set(it.id, null);
        itemsWithoutOffer++;
        exceptions.push(
          `${order.orderNumber} / item ${it.id} (${it.name}): ${offers.length} FIRST_PARTY offers for variant ${it.variantId} — offerId left NULL (not deterministic)`,
        );
      }
    }

    console.log(
      `  ${order.orderNumber}: Order.status ${order.status}/${order.paymentStatus} -> SellerOrder ${status}/${settlementStatus}` +
        `  merch ${merchandiseSubtotal} disc ${discountAllocated} ship ${shippingFee} total ${total}` +
        `  items ${order.items.length} (${[...itemOfferIds.values()].filter(Boolean).length} with offerId)`,
    );

    if (DRY_RUN) {
      created++;
      itemsLinked += order.items.length;
      itemsWithoutOffer += 0;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      const so = await tx.sellerOrder.create({
        data: {
          orderId: order.id,
          sellerId: axiaro.id,
          sellerName: axiaro.displayName,
          sellerType: axiaro.type,
          supportEmail: axiaro.supportEmail,
          commissionRate: 0,
          shippingMethodCode: order.shippingMethodCode ?? null,
          shippingMethodName: order.shippingMethodName ?? null,
          shippingFee,
          platformShippingSubsidy: 0,
          freeShippingApplied: null,
          merchandiseSubtotal,
          discountAllocated,
          discountFundedBy: "PLATFORM",
          commissionAmount,
          total,
          status,
          settlementStatus,
        },
        select: { id: true },
      });

      for (const it of order.items) {
        await tx.orderItem.update({
          where: { id: it.id },
          data: {
            sellerOrderId: so.id,
            sellerId: axiaro.id,
            offerId: itemOfferIds.get(it.id) ?? null,
            commissionRate: 0,
          },
        });
      }
    });

    created++;
    itemsLinked += order.items.length;
  }

  if (reconcileFailures.length > 0) {
    console.error(`\n  HARD STOP — ${reconcileFailures.length} order(s) do not reconcile. NOTHING was changed for these:`);
    for (const f of reconcileFailures) console.error(`    ${f}`);
    process.exitCode = 1;
  }

  console.log(`\n  ── summary ──`);
  console.log(`  orders processed:        ${orders.length}`);
  console.log(`  SellerOrders ${DRY_RUN ? "to create" : "created"}:     ${created}`);
  console.log(`  orders skipped (had SO): ${skipped}`);
  console.log(`  OrderItems ${DRY_RUN ? "to link" : "linked"}:        ${itemsLinked}`);
  console.log(`  items without safe Offer mapping: ${itemsWithoutOffer}`);
  console.log(`  Shipments created: 0  (no historical order carries safe courier/tracking data — 9E-3C-1 §11)`);
  console.log(`  orders without a backfilled Shipment: ${orders.length}`);

  if (exceptions.length > 0) {
    console.log(`\n  exceptions / notes (${exceptions.length}):`);
    for (const e of exceptions) console.log(`    - ${e}`);
  } else {
    console.log(`\n  no exceptions.`);
  }

  if (reconcileFailures.length === 0) {
    console.log(`\n  ${DRY_RUN ? "DRY RUN complete — nothing written." : "Backfill complete."}`);
  }
}

async function revert() {
  const linked = await prisma.orderItem.count({ where: { sellerOrderId: { not: null } } });
  const sos = await prisma.sellerOrder.count();
  const shipments = await prisma.shipment.count();
  console.log(`  current: ${sos} SellerOrder, ${shipments} Shipment, ${linked} linked OrderItem`);
  if (DRY_RUN) {
    console.log(`  DRY RUN — would null OrderItem marketplace columns and delete all SellerOrder rows.`);
    return;
  }
  await prisma.$transaction(async (tx) => {
    await tx.orderItem.updateMany({
      data: { sellerOrderId: null, sellerId: null, offerId: null, commissionRate: null },
    });
    // Shipments cascade with SellerOrder.
    await tx.sellerOrder.deleteMany({});
  });
  console.log(`  reverted: OrderItem marketplace columns nulled, all SellerOrder + Shipment rows deleted.`);
  console.log(`  NOTE: the marketplace.multiSellerCheckout StoreSetting row is left in place (harmless, unread).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
