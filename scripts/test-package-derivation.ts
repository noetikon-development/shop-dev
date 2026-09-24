/**
 * `deriveShipmentPackage()` — provider-agnostic package (weight + dimensions)
 * derivation from a SellerOrder's own line items (Phase 9F-48 design step 5).
 *
 * Pure read, no side effects — every fixture (Category/Product/Variant/User/
 * Order/SellerOrder/OrderItem) is built inside ONE rolled-back
 * `prisma.$transaction`, mirroring `scripts/test-lalamove-provider.ts`'s own
 * fixture-chain pattern. Nothing persists; no Lalamove call is made anywhere
 * in this file.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-package-derivation.ts
 */
import { PrismaClient } from "@prisma/client";
import { deriveShipmentPackage } from "@/lib/marketplace/seller-order-repository";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
class Rollback extends Error {}

async function main() {
  console.log("\nderiveShipmentPackage() — package derivation from SellerOrder line items\n");

  const before = {
    products: await prisma.product.count(),
    variants: await prisma.variant.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    orderItems: await prisma.orderItem.count(),
  };

  try {
    await prisma.$transaction(async (tx) => {
      const sfx = Math.random().toString(36).slice(2, 8);
      const category = await tx.category.findFirst({ select: { id: true } });
      if (!category) throw new Rollback();
      const seller = await tx.seller.findFirst({ where: { type: "THIRD_PARTY" }, select: { id: true } });
      if (!seller) throw new Rollback();
      const buyer = await tx.user.findFirst({ select: { id: true } });

      const mkProduct = async (
        tag: string,
        dims: { weightGrams?: number; lengthCm?: number | null; widthCm?: number | null; heightCm?: number | null },
      ) =>
        tx.product.create({
          data: {
            name: `Pkg Test ${tag} ${sfx}`,
            slug: `pkg-test-${tag}-${sfx}`,
            shortDescription: "s",
            description: "d",
            categoryId: category.id,
            status: "DRAFT",
            price: 1000,
            ...(dims.weightGrams !== undefined ? { weightGrams: dims.weightGrams } : {}),
            lengthCm: dims.lengthCm === undefined ? 50 : dims.lengthCm,
            widthCm: dims.widthCm === undefined ? 30 : dims.widthCm,
            heightCm: dims.heightCm === undefined ? 20 : dims.heightCm,
          },
          select: { id: true },
        });

      const mkVariant = async (productId: string, tag: string) =>
        tx.variant.create({ data: { productId, sku: `PKG-${tag}-${sfx}`, price: 1000 }, select: { id: true } });

      const mkOrder = async () =>
        tx.order.create({
          data: {
            orderNumber: `AX-PKG-${sfx}-${Math.random().toString(36).slice(2, 6)}`,
            email: "b@e.test",
            phone: "+630",
            status: "PROCESSING",
            paymentMethod: "COD",
            paymentStatus: "PENDING",
            subtotal: 1000,
            grandTotal: 1000,
            shippingFee: 0,
            shippingAddress: "{}",
            userId: buyer?.id,
          },
          select: { id: true },
        });

      const mkSellerOrder = async (orderId: string) =>
        tx.sellerOrder.create({
          data: {
            orderId,
            sellerId: seller.id,
            sellerName: "S",
            sellerType: "THIRD_PARTY",
            supportEmail: "s@t.test",
            merchandiseSubtotal: 1000,
            total: 1000,
            commissionRate: 1500,
            commissionAmount: 150,
            status: "PROCESSING",
          },
          select: { id: true },
        });

      const mkItem = async (
        orderId: string,
        sellerOrderId: string,
        opts: { variantId?: string | null; quantity: number },
      ) =>
        tx.orderItem.create({
          data: {
            orderId,
            productId: "snapshot-id-unused",
            variantId: opts.variantId ?? null,
            sellerOrderId,
            name: "line",
            unitPrice: 1000,
            quantity: opts.quantity,
            lineTotal: 1000 * opts.quantity,
          },
          select: { id: true },
        });

      // ── A. single item ──────────────────────────────────────────────────
      {
        const p = await mkProduct("single", { weightGrams: 700, lengthCm: 40, widthCm: 25, heightCm: 15 });
        const v = await mkVariant(p.id, "single");
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        await mkItem(o.id, so.id, { variantId: v.id, quantity: 1 });

        const r = await deriveShipmentPackage(so.id, tx);
        ok("A · single item — weight = product.weightGrams * 1",
          r.ok && r.value.weightGrams === 700, JSON.stringify(r));
        ok("A · single item — dimensions = the product's own dimensions",
          r.ok && r.value.lengthCm === 40 && r.value.widthCm === 25 && r.value.heightCm === 15, JSON.stringify(r));
      }

      // ── B. multiple quantities of one item — weight summation ──────────
      {
        const p = await mkProduct("qty", { weightGrams: 300, lengthCm: 20, widthCm: 20, heightCm: 20 });
        const v = await mkVariant(p.id, "qty");
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        await mkItem(o.id, so.id, { variantId: v.id, quantity: 4 });

        const r = await deriveShipmentPackage(so.id, tx);
        ok("B · quantity 4 — weight = 300 * 4 = 1200 (summed, not just one unit)",
          r.ok && r.value.weightGrams === 1200, JSON.stringify(r));
        ok("B · quantity 4 — dimensions are NOT multiplied by quantity (still the single product's own size)",
          r.ok && r.value.lengthCm === 20 && r.value.widthCm === 20 && r.value.heightCm === 20, JSON.stringify(r));
      }

      // ── C/D. multiple DIFFERENT products — weight sum + per-axis MAX ────
      {
        const pA = await mkProduct("multiA", { weightGrams: 500, lengthCm: 60, widthCm: 10, heightCm: 10 }); // tallest length
        const pB = await mkProduct("multiB", { weightGrams: 800, lengthCm: 10, widthCm: 90, heightCm: 10 }); // tallest width
        const pC = await mkProduct("multiC", { weightGrams: 200, lengthCm: 10, widthCm: 10, heightCm: 70 }); // tallest height
        const vA = await mkVariant(pA.id, "multiA");
        const vB = await mkVariant(pB.id, "multiB");
        const vC = await mkVariant(pC.id, "multiC");
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        await mkItem(o.id, so.id, { variantId: vA.id, quantity: 1 });
        await mkItem(o.id, so.id, { variantId: vB.id, quantity: 2 });
        await mkItem(o.id, so.id, { variantId: vC.id, quantity: 1 });

        const r = await deriveShipmentPackage(so.id, tx);
        ok("C · multiple products — weight = sum across ALL items (500*1 + 800*2 + 200*1 = 2300)",
          r.ok && r.value.weightGrams === 2300, JSON.stringify(r));
        ok("D · per-axis maximum — length takes product A's 60, NOT summed across products",
          r.ok && r.value.lengthCm === 60, JSON.stringify(r));
        ok("D · per-axis maximum — width takes product B's 90",
          r.ok && r.value.widthCm === 90, JSON.stringify(r));
        ok("D · per-axis maximum — height takes product C's 70",
          r.ok && r.value.heightCm === 70, JSON.stringify(r));

        // ── I. deterministic — same fixture, same call, same result ──────
        const r2 = await deriveShipmentPackage(so.id, tx);
        ok("I · deriveShipmentPackage is deterministic — a second call on the same SellerOrder returns an identical result",
          r.ok && r2.ok && JSON.stringify(r.value) === JSON.stringify(r2.value));
      }

      // ── E. zero/invalid quantity — skipped, not an error, not counted ───
      {
        const pGood = await mkProduct("zeroGood", { weightGrams: 400, lengthCm: 15, widthCm: 15, heightCm: 15 });
        const pZero = await mkProduct("zeroSkip", { weightGrams: 99999, lengthCm: 999, widthCm: 999, heightCm: 999 });
        const vGood = await mkVariant(pGood.id, "zeroGood");
        const vZero = await mkVariant(pZero.id, "zeroSkip");
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        await mkItem(o.id, so.id, { variantId: vGood.id, quantity: 1 });
        await mkItem(o.id, so.id, { variantId: vZero.id, quantity: 0 }); // zero-quantity line, e.g. a cancelled/adjusted line

        const r = await deriveShipmentPackage(so.id, tx);
        ok("E · a quantity=0 line is skipped entirely — result reflects ONLY the qty>0 item (400g / 15cm), not the huge zero-qty product",
          r.ok && r.value.weightGrams === 400 && r.value.lengthCm === 15, JSON.stringify(r));
      }

      // ── F. missing product/variant data — clean explicit error ─────────
      {
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        await mkItem(o.id, so.id, { variantId: null, quantity: 1 }); // no variant linked at all

        const r = await deriveShipmentPackage(so.id, tx);
        ok("F · an item with no linked variant/product → clean ok:false error, no guessed weight/dimensions",
          !r.ok && /variant|product/i.test(r.error), JSON.stringify(r));
      }

      // ── G. missing dimension on an otherwise-real product ───────────────
      {
        const p = await mkProduct("nodims", { weightGrams: 350, lengthCm: null, widthCm: 20, heightCm: 20 });
        const v = await mkVariant(p.id, "nodims");
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        await mkItem(o.id, so.id, { variantId: v.id, quantity: 1 });

        const r = await deriveShipmentPackage(so.id, tx);
        ok("G · a product missing a dimension (lengthCm null) → clean ok:false error naming the product, no zero/guessed value",
          !r.ok && r.error.includes("Pkg Test nodims") && /dimension/i.test(r.error), JSON.stringify(r));
      }

      // ── H. empty SellerOrder — no items at all ──────────────────────────
      {
        const o = await mkOrder();
        const so = await mkSellerOrder(o.id);
        const r = await deriveShipmentPackage(so.id, tx);
        ok("H · a SellerOrder with zero line items → clean ok:false error, no provider call attempted",
          !r.ok && /no shippable items/i.test(r.error), JSON.stringify(r));
      }

      // ── a nonexistent SellerOrder id behaves the same as empty ─────────
      {
        const r = await deriveShipmentPackage("does-not-exist-" + sfx, tx);
        ok("a nonexistent sellerOrderId → same clean ok:false result as an empty order (0 items found)", !r.ok);
      }

      throw new Rollback();
    }, { timeout: 30_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = {
    products: await prisma.product.count(),
    variants: await prisma.variant.count(),
    orders: await prisma.order.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    orderItems: await prisma.orderItem.count(),
  };
  ok("rollback · no fixture row leaked (Product/Variant/Order/SellerOrder/OrderItem counts all unchanged)",
    JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
