/**
 * Phase 9C — marketplace foundation reconciliation.
 *
 * Verifies the 21 assertions from the Phase 9C spec. FAILS LOUDLY (exit 1) on
 * any discrepancy and never repairs anything. Read-only.
 *
 * Run:  npm run db:reconcile:marketplace
 *
 * The "no existing data changed" checks compare live counts against a recorded
 * pre-migration baseline (captured 2026-09-03, before the backfill). Override
 * with  --baseline='{"product":37,...}'  if re-running in another environment.
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

/** Pre-migration baseline (captured before the Phase 9C backfill ran). */
const BASELINE = {
  product: 37,
  variant: 328,
  variantActive: 328,
  inventory: 328,
  inventoryAdjustment: 2,
  inventorySumQuantity: 4208,
  inventorySumReserved: 0,
  order: 3,
  orderItem: 3,
  review: 61,
  wishlistItem: 4,
  productQuestion: 0,
  productAnswer: 0,
  payment: 0,
  coupon: 4,
  user: 6,
  category: 46,
};

type Check = { n: number; name: string; pass: boolean; detail?: string };

export async function reconcile(prisma: PrismaClient, baseline = BASELINE) {
  const checks: Check[] = [];
  const add = (n: number, name: string, pass: boolean, detail?: string) =>
    checks.push({ n, name, pass, detail });

  // ---- marketplace side --------------------------------------------------
  const sellers = await prisma.seller.findMany({
    select: { id: true, type: true, status: true, slug: true, commissionRate: true },
  });
  const fp = sellers.filter((s) => s.type === "FIRST_PARTY");
  const tp = sellers.filter((s) => s.type === "THIRD_PARTY");

  add(1, "Exactly one Axiaro FIRST_PARTY Seller exists", fp.length === 1,
    `FIRST_PARTY sellers: ${fp.length}`);

  const axiaro = fp[0];
  if (axiaro) {
    add(1.1, "Axiaro seller is APPROVED, slug 'axiaro', commission 0",
      axiaro.status === "APPROVED" && axiaro.slug === "axiaro" && axiaro.commissionRate === 0,
      `status=${axiaro.status} slug=${axiaro.slug} commissionRate=${axiaro.commissionRate}`);
  }

  add(13, "No unexpected THIRD_PARTY seller exists", tp.length === 0,
    `THIRD_PARTY sellers: ${tp.length}`);

  const qualifyingVariants = await prisma.variant.findMany({
    where: { status: "ACTIVE", product: { status: { in: ["ACTIVE", "DRAFT"] } } },
    select: {
      id: true,
      sku: true,
      price: true,
      compareAtPrice: true,
      product: { select: { costPrice: true, status: true } },
      inventory: { select: { quantity: true, reserved: true, reorderPoint: true, restockEta: true } },
    },
  });

  const axiaroOffers = axiaro
    ? await prisma.offer.findMany({
        where: { sellerId: axiaro.id },
        select: {
          id: true,
          variantId: true,
          condition: true,
          price: true,
          compareAtPrice: true,
          costPrice: true,
          sellerSku: true,
          status: true,
          fulfillmentType: true,
          seller: { select: { id: true } },
          variant: { select: { id: true } },
          inventory: {
            select: { id: true, quantity: true, reserved: true, reorderPoint: true, restockEta: true },
          },
        },
      })
    : [];

  const offersByVariant = new Map<string, typeof axiaroOffers>();
  for (const o of axiaroOffers) {
    const arr = offersByVariant.get(o.variantId) ?? [];
    arr.push(o);
    offersByVariant.set(o.variantId, arr);
  }

  add(2, "Every qualifying ACTIVE Variant has exactly one Axiaro Offer",
    qualifyingVariants.every((v) => (offersByVariant.get(v.id)?.length ?? 0) === 1),
    `qualifying=${qualifyingVariants.length}, offers=${axiaroOffers.length}, ` +
      `variants missing an offer=${qualifyingVariants.filter((v) => !offersByVariant.get(v.id)).length}`);

  add(21, "No duplicate Axiaro Offer for the same Variant/condition",
    [...offersByVariant.values()].every((arr) => {
      const keys = arr.map((o) => o.condition);
      return new Set(keys).size === keys.length;
    }) && axiaroOffers.length === new Set(axiaroOffers.map((o) => `${o.variantId}:${o.condition}`)).size,
    `distinct (variant,condition) = ${new Set(axiaroOffers.map((o) => `${o.variantId}:${o.condition}`)).size}`);

  add(3, "Every Axiaro Offer has exactly one OfferInventory",
    axiaroOffers.every((o) => o.inventory != null),
    `offers without inventory: ${axiaroOffers.filter((o) => !o.inventory).length}`);

  const [nullSeller, nullVariant, orphanInv] = await Promise.all([
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Offer" WHERE "sellerId" IS NULL`,
    prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM "Offer" WHERE "variantId" IS NULL`,
    prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM "OfferInventory" oi
      LEFT JOIN "Offer" o ON o."id" = oi."offerId" WHERE o."id" IS NULL`,
  ]);
  add(18, "No Offer exists without a Seller", Number(nullSeller[0].n) === 0, `null sellerId: ${nullSeller[0].n}`);
  add(19, "No Offer exists without a Variant", Number(nullVariant[0].n) === 0, `null variantId: ${nullVariant[0].n}`);
  add(20, "No OfferInventory exists without an Offer", Number(orphanInv[0].n) === 0, `orphans: ${orphanInv[0].n}`);

  // field-by-field copy checks (4-11)
  const byVariant = new Map(qualifyingVariants.map((v) => [v.id, v]));
  let priceMismatch = 0, compareMismatch = 0, costMismatch = 0, skuMismatch = 0;
  let qtyMismatch = 0, reservedMismatch = 0, reorderMismatch = 0, etaMismatch = 0, invariantFail = 0;
  for (const o of axiaroOffers) {
    const v = byVariant.get(o.variantId);
    if (!v || !v.inventory || !o.inventory) continue;
    if (o.price !== v.price) priceMismatch++;
    if ((o.compareAtPrice ?? null) !== (v.compareAtPrice ?? null)) compareMismatch++;
    if ((o.costPrice ?? null) !== (v.product.costPrice ?? null)) costMismatch++;
    if ((o.sellerSku ?? null) !== v.sku) skuMismatch++;
    if (o.inventory.quantity !== v.inventory.quantity) qtyMismatch++;
    if (o.inventory.reserved !== v.inventory.reserved) reservedMismatch++;
    if (o.inventory.reorderPoint !== v.inventory.reorderPoint) reorderMismatch++;
    if (String(o.inventory.restockEta ?? null) !== String(v.inventory.restockEta ?? null)) etaMismatch++;
    if (o.inventory.quantity < o.inventory.reserved) invariantFail++;
  }
  add(4, "Offer.price == source Variant.price", priceMismatch === 0, `mismatches: ${priceMismatch}`);
  add(5, "Offer.compareAtPrice == source Variant.compareAtPrice", compareMismatch === 0, `mismatches: ${compareMismatch}`);
  add(6, "Offer.costPrice == source Product.costPrice", costMismatch === 0, `mismatches: ${costMismatch}`);
  add(7, "Offer.sellerSku == source Variant.sku", skuMismatch === 0, `mismatches: ${skuMismatch}`);
  add(8, "OfferInventory.quantity == source Inventory.quantity", qtyMismatch === 0, `mismatches: ${qtyMismatch}`);
  add(9, "OfferInventory.reserved == source Inventory.reserved", reservedMismatch === 0, `mismatches: ${reservedMismatch}`);
  add(10, "OfferInventory.reorderPoint == source Inventory.reorderPoint", reorderMismatch === 0, `mismatches: ${reorderMismatch}`);
  add(11, "OfferInventory.restockEta == source Inventory.restockEta", etaMismatch === 0, `mismatches: ${etaMismatch}`);
  add(12, "quantity >= reserved for every OfferInventory", invariantFail === 0, `violations: ${invariantFail}`);

  const openingAdj = await prisma.offerAdjustment.count({ where: { reason: "MIGRATION_OPENING" } });
  const totalAdj = await prisma.offerAdjustment.count();
  add(12.1, "Exactly one MIGRATION_OPENING OfferAdjustment per OfferInventory",
    openingAdj === axiaroOffers.length && totalAdj === openingAdj,
    `MIGRATION_OPENING=${openingAdj}, total OfferAdjustment=${totalAdj}, offers=${axiaroOffers.length}`);

  // ---- existing data untouched (14-17) ---------------------------------
  const [product, variant, variantActive, inventory, inventoryAdjustment, order, orderItem, review, wishlistItem, productQuestion, productAnswer, payment, coupon, user, category] =
    await Promise.all([
      prisma.product.count(),
      prisma.variant.count(),
      prisma.variant.count({ where: { status: "ACTIVE" } }),
      prisma.inventory.count(),
      prisma.inventoryAdjustment.count(),
      prisma.order.count(),
      prisma.orderItem.count(),
      prisma.review.count(),
      prisma.wishlistItem.count(),
      prisma.productQuestion.count(),
      prisma.productAnswer.count(),
      prisma.payment.count(),
      prisma.coupon.count(),
      prisma.user.count(),
      prisma.category.count(),
    ]);
  const invAgg = await prisma.inventory.aggregate({ _sum: { quantity: true, reserved: true } });

  add(14, "Existing Product count unchanged", product === baseline.product, `${baseline.product} → ${product}`);
  add(15, "Existing Variant count unchanged", variant === baseline.variant, `${baseline.variant} → ${variant}`);
  add(16, "Existing Inventory count + totals unchanged",
    inventory === baseline.inventory &&
      (invAgg._sum.quantity ?? 0) === baseline.inventorySumQuantity &&
      (invAgg._sum.reserved ?? 0) === baseline.inventorySumReserved,
    `count ${baseline.inventory}→${inventory}, Σqty ${baseline.inventorySumQuantity}→${invAgg._sum.quantity}, Σreserved ${baseline.inventorySumReserved}→${invAgg._sum.reserved}`);
  add(17, "Existing InventoryAdjustment count unchanged",
    inventoryAdjustment === baseline.inventoryAdjustment,
    `${baseline.inventoryAdjustment} → ${inventoryAdjustment}`);

  add(17.1, "Existing Order / OrderItem / Review / Wishlist / Q&A / Payment counts unchanged",
    order === baseline.order && orderItem === baseline.orderItem && review === baseline.review &&
      wishlistItem === baseline.wishlistItem && productQuestion === baseline.productQuestion &&
      productAnswer === baseline.productAnswer && payment === baseline.payment &&
      coupon === baseline.coupon && user === baseline.user && category === baseline.category,
    `orders ${order} items ${orderItem} reviews ${review} wishlist ${wishlistItem} q ${productQuestion} a ${productAnswer} payments ${payment} coupons ${coupon} users ${user} categories ${category}`);
  void variantActive;

  // ---- report ---------------------------------------------------------
  const failed = checks.filter((c) => !c.pass);
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks.sort((a, b) => a.n - b.n)) {
    const mark = c.pass ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${String(c.n).padEnd(4)} ${c.name.padEnd(width)}  ${c.detail ?? ""}`);
  }
  console.log(`\n  ${checks.length} checks, ${failed.length} failed.`);

  if (failed.length > 0) {
    console.error(`\nRECONCILIATION FAILED: ${failed.map((f) => `#${f.n}`).join(", ")}`);
    throw new Error("Marketplace foundation reconciliation failed.");
  }
  console.log("\nRECONCILIATION PASSED.");
  return { checks: checks.length, failed: 0 };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  const arg = process.argv.find((a) => a.startsWith("--baseline="));
  const baseline = arg ? { ...BASELINE, ...JSON.parse(arg.slice("--baseline=".length)) } : BASELINE;
  reconcile(prisma, baseline)
    .catch((e) => {
      console.error(e.message ?? e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
