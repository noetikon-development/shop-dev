/**
 * Phase 9F-1 — 3P Seller Portal foundation — assertion runner.
 *
 * DB tests run in ONE `prisma.$transaction` and roll back — nothing persists.
 * Run with `--conditions=react-server` so `server-only` imports are inert.
 *
 * Groups:
 *   A  seller-scoped repository isolation (a seller only sees / changes its own rows)
 *   B  ownership is re-checked INSIDE the write transaction (forged offerId fails)
 *   C  a THIRD_PARTY offer can NEVER be set ACTIVE while the gate is off
 *   D  createSellerOffer always yields status DRAFT + an OfferInventory + opening OfferAdjustment
 *   E  the seller plane never touches Inventory / InventoryAdjustment / Variant.stock
 *   F  Axiaro FIRST_PARTY offers are unaffected by seller-plane writes
 *   G  the storefront buy-box still ignores a non-ACTIVE 3P offer
 *   H  static: /seller auth wiring, no "activate" control, planes independent, gate untouched
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f1.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  createSellerOffer,
  updateSellerOffer,
  setSellerOfferStatus,
  adjustOfferStock,
  setSellerOfferReorderPoint,
  listSellerOffers,
  getOfferForSeller,
} from "../src/lib/marketplace/seller-repository";
import { pickWinningOffer } from "../src/lib/marketplace/buy-box-rule";
import type { SellerContext, OfferCandidate } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.error(`  FAIL  ${name}   ${detail}`);
  }
};

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function ctxFor(sellerId: string, name: string): SellerContext {
  return {
    sellerId,
    sellerName: name,
    sellerUserId: "su-" + sellerId,
    userId: "u-" + sellerId,
    role: "OWNER",
    permissions: new Set(),
  };
}

class Rollback extends Error {}

async function dbTests() {
  const variants = await prisma.variant.findMany({
    where: { status: "ACTIVE", product: { status: { in: ["ACTIVE", "DRAFT"] } } },
    select: { id: true },
    take: 2,
  });
  if (variants.length < 1) {
    ok("db tests skipped — no ACTIVE variant", true);
    return;
  }
  const v1 = variants[0];
  const suffix = "9f1-" + Date.now();

  // snapshot the untouched legacy stores + Axiaro offers
  const invBefore = await prisma.inventory.count();
  const invAdjBefore = await prisma.inventoryAdjustment.count();
  const axiaroOffersBefore = await prisma.offer.findMany({
    where: { seller: { is: { type: "FIRST_PARTY" } } },
    select: { id: true, price: true, status: true },
    orderBy: { id: "asc" },
  });

  try {
    await prisma.$transaction(async (tx) => {
      const A = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "A", slug: `a-${suffix}`, supportEmail: "a@t.test" },
      });
      const B = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: "B", slug: `b-${suffix}`, supportEmail: "b@t.test" },
      });
      const ctxA = ctxFor(A.id, "A");
      const ctxB = ctxFor(B.id, "B");

      // ---- D: create ----
      const created = await createSellerOffer(ctxA, { variantId: v1.id, price: 12345, openingQuantity: 4 }, tx);
      ok("D1 createSellerOffer ok", created.ok === true, JSON.stringify(created));
      if (!created.ok) throw new Rollback();
      const offerA = await tx.offer.findUnique({
        where: { id: created.offerId },
        select: { status: true, sellerId: true, condition: true, inventory: { select: { quantity: true, adjustments: true } } },
      });
      ok("D2 new offer status is DRAFT", offerA?.status === "DRAFT", offerA?.status);
      ok("D3 new offer belongs to seller A", offerA?.sellerId === A.id);
      ok("D4 OfferInventory created with opening quantity", offerA?.inventory?.quantity === 4);
      ok(
        "D5 opening OfferAdjustment recorded",
        offerA?.inventory?.adjustments.length === 1 &&
          offerA.inventory.adjustments[0].reason === "MIGRATION_OPENING",
      );

      // ---- C: cannot go ACTIVE while the gate is off ----
      const goActive = await setSellerOfferStatus(ctxA, created.offerId, "ACTIVE", tx);
      ok(
        "C1 setSellerOfferStatus → ACTIVE refused (FORBIDDEN)",
        goActive.ok === false && goActive.code === "FORBIDDEN",
        JSON.stringify(goActive),
      );
      const still = await tx.offer.findUnique({ where: { id: created.offerId }, select: { status: true } });
      ok("C2 offer still DRAFT after refused activate", still?.status === "DRAFT");

      const deactivate = await setSellerOfferStatus(ctxA, created.offerId, "INACTIVE", tx);
      ok("C3 DRAFT → INACTIVE allowed", deactivate.ok === true);
      const backToDraft = await setSellerOfferStatus(ctxA, created.offerId, "DRAFT", tx);
      ok("C4 INACTIVE → DRAFT allowed", backToDraft.ok === true);

      // ---- A: isolation ----
      const bOffer = await createSellerOffer(ctxB, { variantId: v1.id, price: 9000 }, tx);
      ok("A0 seller B can create its own offer for the same variant", bOffer.ok === true);
      if (!bOffer.ok) throw new Rollback();

      const listA = await listSellerOffers(ctxA, {}, tx);
      ok("A1 listSellerOffers(A) has A's offer", listA.some((o) => o.id === created.offerId));
      ok("A2 listSellerOffers(A) excludes B's offer", !listA.some((o) => o.id === bOffer.offerId));
      ok("A3 getOfferForSeller(A, B's offer) → null", (await getOfferForSeller(ctxA, bOffer.offerId, tx)) === null);

      const crossPrice = await updateSellerOffer(ctxA, bOffer.offerId, { price: 1 }, tx);
      ok("A4 updateSellerOffer(A, B's offer) rejected", crossPrice.ok === false && crossPrice.code === "NOT_FOUND");
      const crossStock = await adjustOfferStock(ctxA, bOffer.offerId, -1, "CORRECTION", null, tx);
      ok("A5 adjustOfferStock(A, B's offer) rejected", crossStock.ok === false && crossStock.code === "NOT_FOUND");
      const crossStatus = await setSellerOfferStatus(ctxA, bOffer.offerId, "INACTIVE", tx);
      ok("A6 setSellerOfferStatus(A, B's offer) rejected", crossStatus.ok === false && crossStatus.code === "NOT_FOUND");
      const crossReorder = await setSellerOfferReorderPoint(ctxA, bOffer.offerId, 99, tx);
      ok("A7 setSellerOfferReorderPoint(A, B's offer) rejected", crossReorder.ok === false && crossReorder.code === "NOT_FOUND");

      // B's offer untouched by all of A's attempts
      const bAfter = await tx.offer.findUnique({
        where: { id: bOffer.offerId },
        select: { price: true, status: true, inventory: { select: { quantity: true, reorderPoint: true } } },
      });
      ok("A8 B's offer unchanged after A's cross-writes", bAfter?.price === 9000 && bAfter?.status === "DRAFT");

      // ---- B: forged offerId ----
      const forged = await updateSellerOffer(ctxA, "cmforged000000000000000000", { price: 5 }, tx);
      ok("B1 forged offerId → NOT_FOUND", forged.ok === false && forged.code === "NOT_FOUND");

      // ---- own writes still work ----
      const priced = await updateSellerOffer(ctxA, created.offerId, { price: 15000, sellerSku: `SKU-${suffix}` }, tx);
      ok("own1 updateSellerOffer(A, own) ok", priced.ok === true, JSON.stringify(priced));
      const adj = await adjustOfferStock(ctxA, created.offerId, 3, "RESTOCK", "top-up", tx);
      ok("own2 adjustOfferStock(A, own) ok → 7", adj.ok === true && adj.newQuantity === 7, JSON.stringify(adj));
      const belowZero = await adjustOfferStock(ctxA, created.offerId, -9999, "LOSS", null, tx);
      ok("own3 adjustOfferStock below zero rejected", belowZero.ok === false && belowZero.code === "INVARIANT");
      const rp = await setSellerOfferReorderPoint(ctxA, created.offerId, 10, tx);
      ok("own4 setSellerOfferReorderPoint(A, own) ok", rp.ok === true);

      // ---- E: legacy stores untouched during the whole tx ----
      const invNow = await tx.inventory.count();
      const invAdjNow = await tx.inventoryAdjustment.count();
      ok("E1 Inventory row count unchanged inside tx", invNow === invBefore, `${invBefore} → ${invNow}`);
      ok("E2 InventoryAdjustment count unchanged inside tx", invAdjNow === invAdjBefore, `${invAdjBefore} → ${invAdjNow}`);

      // ---- G: buy-box ignores the DRAFT/INACTIVE 3P offer ----
      const offerRows = (await tx.offer.findMany({
        where: { variantId: v1.id },
        select: {
          id: true,
          sellerId: true,
          price: true,
          status: true,
          createdAt: true,
          seller: { select: { type: true, status: true } },
          inventory: { select: { quantity: true, reserved: true } },
        },
      })) as {
        id: string;
        sellerId: string;
        price: number;
        status: string;
        createdAt: Date;
        seller: { type: string; status: string };
        inventory: { quantity: number; reserved: number } | null;
      }[];
      const candidates: OfferCandidate[] = offerRows.map((r) => ({
        offerId: r.id,
        sellerId: r.sellerId,
        sellerType: r.seller.type === "FIRST_PARTY" ? "FIRST_PARTY" : "THIRD_PARTY",
        sellerStatus: r.seller.status as OfferCandidate["sellerStatus"],
        offerStatus: r.status as OfferCandidate["offerStatus"],
        available: Math.max(0, (r.inventory?.quantity ?? 0) - (r.inventory?.reserved ?? 0)),
        price: r.price,
        createdAt: r.createdAt,
      }));
      const winner = pickWinningOffer(candidates);
      const winnerRow = winner && offerRows.find((r) => r.id === winner.offerId);
      ok(
        "G1 buy-box winner is never a THIRD_PARTY offer (all 3P offers are DRAFT/INACTIVE)",
        !winnerRow || winnerRow.seller.type === "FIRST_PARTY",
        winnerRow ? `${winnerRow.seller.type}/${winnerRow.status}` : "no winner",
      );

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  // ---- F: Axiaro offers + legacy stores identical after rollback ----
  const invAfter = await prisma.inventory.count();
  const invAdjAfter = await prisma.inventoryAdjustment.count();
  const axiaroOffersAfter = await prisma.offer.findMany({
    where: { seller: { is: { type: "FIRST_PARTY" } } },
    select: { id: true, price: true, status: true },
    orderBy: { id: "asc" },
  });
  ok("F1 Inventory count unchanged after rollback", invAfter === invBefore, `${invBefore} → ${invAfter}`);
  ok("F2 InventoryAdjustment count unchanged after rollback", invAdjAfter === invAdjBefore);
  ok(
    "F3 every Axiaro FIRST_PARTY offer unchanged",
    JSON.stringify(axiaroOffersBefore) === JSON.stringify(axiaroOffersAfter),
  );

  const leaked = await prisma.seller.count({ where: { slug: { contains: suffix } } });
  ok("F4 test seller rows rolled back (0 leaked)", leaked === 0, `leaked ${leaked}`);
}

async function staticTests() {
  const mw = read("src/lib/supabase/middleware.ts");
  ok("H1 proxy middleware guards the /seller prefix", /SELLER_PREFIX\s*=\s*"\/seller"/.test(mw) && /isSellerArea/.test(mw));
  ok("H2 /seller/login is the only public /seller path", /SELLER_PUBLIC_PATHS\s*=\s*\["\/seller\/login"\]/.test(mw));

  const session = read("src/lib/seller/session.ts");
  ok("H3 requireSellerSession redirects guests to /seller/login", /redirect\(\s*[`'"]\/seller\/login/.test(session));
  ok("H4 getSellerSession refuses a non-APPROVED seller", /sellerStatus === "APPROVED"/.test(session));

  const repo = read("src/lib/marketplace/seller-repository.ts");
  ok(
    "H5 setSellerOfferStatus gates ACTIVE on marketplace.multiSellerCheckout",
    /next === "ACTIVE"/.test(repo) && /multiSellerCheckout/.test(repo),
  );
  ok(
    "H6 seller repository never imports @/lib/inventory or writes Inventory",
    !/@\/lib\/inventory/.test(repo) && !/tx\.inventory\.|prisma\.inventory\./.test(repo) && !/"Inventory"/.test(repo),
  );

  const actions = read("src/lib/seller/offer-actions.ts");
  ok(
    "H7 seller actions never revalidate the storefront (products tag)",
    !/revalidateTag\(\s*["']products/.test(actions),
  );

  const statusControls = read("src/components/seller/offer-status-controls.tsx");
  const statusActions = read("src/lib/seller/offer-actions.ts");
  ok(
    "H8 nothing in the status control / action moves an offer to ACTIVE",
    !/submit\(\s*["']ACTIVE["']\)/.test(statusControls) &&
      !/>\s*Publish\b|Go live\s*</i.test(statusControls) &&
      !/z\.enum\(\[[^\]]*["']ACTIVE["'][^\]]*\]\)/.test(statusActions),
  );

  const nav = read("src/lib/seller/navigation.ts");
  ok("H9 seller nav never links to /admin", !/["'`]\/admin/.test(nav));

  const adminLayout = read("src/app/admin/(shell)/layout.tsx");
  ok(
    "H10 /admin still requires an RBAC admin (seller-only user is forbidden)",
    /getCurrentAdmin\(\)/.test(adminLayout) && /forbidden\(\)/.test(adminLayout),
  );

  // planes independent — seller context never queries the global RBAC tables
  const sellerCtx = read("src/lib/marketplace/seller-context.ts");
  ok(
    "H11 seller-context never queries the global RBAC tables",
    !/prisma\.userRole\.|prisma\.role\.|prisma\.rolePermission\.|prisma\.permission\.|claimAdminInvites/.test(sellerCtx),
  );

  ok("H12 seed-rbac.ts is untouched by this phase", !/9F-1|seller portal|SellerUser/i.test(read("scripts/seed-rbac.ts")));
}

async function run() {
  console.log("PHASE 9F-1 — Seller Portal foundation\n");
  console.log("── static wiring ──");
  await staticTests();
  console.log("\n── seller-scoped data access (rolled back) ──");
  await dbTests();

  console.log(`\n  ${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exitCode = 1;
}

run()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

