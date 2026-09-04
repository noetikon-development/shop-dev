/**
 * Phase 9F-5b — Seller Product Request — assertion runner.
 *
 * DB tests build sellers + requests + seller-owned MediaAsset rows inside ONE
 * prisma.$transaction and roll back. The request repo + seller-media repo take
 * an optional transaction client. Static tests read source files. Run with
 * --conditions=react-server.
 *
 * Coverage (spec VALIDATION 1-30; 23-30 run as separate npm scripts):
 *   1  approved seller can create DRAFT
 *   2  seller can edit DRAFT
 *   3  DRAFT -> PENDING
 *   4  submitted request can't be edited
 *   5  seller cannot approve
 *   6  seller can't read another seller's request
 *   7  cross-seller mutation fails
 *   8  seller attaches only its own MediaAsset
 *   9  cross-seller media attach fails
 *   10 seller media stays seller-owned
 *   11 exact duplicate SKU is blocked
 *   12 barcode duplicate is surfaced
 *   13 normalized name/brand/category duplicate is warned
 *   14 status transitions enforced
 *   15 suspended seller can't submit (session-gated) — static
 *   16 closed seller can't submit — static
 *   17 no Product/Variant/Category/ProductImage writes
 *   18 no Offer/OfferInventory changes
 *   19 no Inventory changes
 *   20 storefront unchanged
 *   21 marketplace.multiSellerCheckout false
 *   22 PayMongo dormant
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f5b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  createSellerRequest,
  updateSellerRequest,
  submitSellerRequest,
  attachRequestImage,
  detachRequestImage,
  checkRequestDuplicates,
  parseProposal,
} from "../src/lib/marketplace/seller-product-request-repository";
import { getSellerRequestForSeller } from "../src/lib/marketplace/seller-product-request-repository";
import type { SellerContext } from "../src/lib/marketplace/types";

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

function ctxFor(sellerId: string): SellerContext {
  return {
    sellerId,
    sellerName: "S",
    sellerUserId: "su-" + sellerId,
    userId: "u-" + sellerId,
    role: "OWNER",
    permissions: new Set(),
  };
}
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function seedSeller(tx: Tx, slug: string, status = "APPROVED") {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status, displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}
async function seedAsset(tx: Tx, sellerId: string) {
  const rnd = Math.random().toString(36).slice(2, 10);
  return tx.mediaAsset.create({
    data: {
      bucket: "media",
      path: `sellers/${sellerId}/${rnd}.png`,
      url: `https://example.test/${rnd}.png`,
      filename: `${rnd}.png`,
      mimeType: "image/png",
      sizeBytes: 2048,
      folder: `sellers/${sellerId}`,
      sellerId,
    },
    select: { id: true, sellerId: true, folder: true },
  });
}
async function snapshot() {
  return {
    product: await prisma.product.count(),
    variant: await prisma.variant.count(),
    category: await prisma.category.count(),
    productImage: await prisma.productImage.count(),
    productOption: await prisma.productOption.count(),
    offer: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    inventory: await prisma.inventory.count(),
    inventoryAdjustment: await prisma.inventoryAdjustment.count(),
    storeSetting: await prisma.storeSetting.count(),
    sellerProductRequest: await prisma.sellerProductRequest.count(),
  };
}

async function dbTests() {
  const before = await snapshot();
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const realVariant = await prisma.variant.findFirst({ select: { sku: true } });
  const realProduct = await prisma.product.findFirst({ select: { name: true, brand: true, categoryId: true } });
  if (!category || !realVariant || !realProduct) {
    ok("db tests skipped — no catalog data", true);
    return;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const t = Date.now().toString(36);
        const A = await seedSeller(tx, `a95b-${t}`);
        const B = await seedSeller(tx, `b95b-${t}`);
        const ctxA = ctxFor(A.id);
        const ctxB = ctxFor(B.id);

        // 1 — create DRAFT
        const created = await createSellerRequest(
          ctxA,
          {
            proposedName: `Custom Widget ${t}`,
            proposedBrand: "Widgetco",
            proposedDescription: "A widget.",
            proposedCategoryId: category.id,
            proposedVariants: [{ label: "Default" }],
          },
          tx,
        );
        ok("1 · createSellerRequest → ok", created.ok === true);
        const reqId = created.ok ? created.requestId : "";
        const row1 = reqId ? await tx.sellerProductRequest.findUnique({ where: { id: reqId }, select: { status: true, sellerId: true } }) : null;
        ok("1 · new request is DRAFT and scoped to the seller", row1?.status === "DRAFT" && row1?.sellerId === A.id);

        // 2 — edit DRAFT
        const edited = await updateSellerRequest(ctxA, reqId, {
          proposedName: `Custom Widget ${t} v2`,
          proposedCategoryId: category.id,
          proposedVariants: [{ label: "Small" }, { label: "Large", proposedSku: `W-${t}-L` }],
        }, tx);
        ok("2 · updateSellerRequest (DRAFT) → ok", edited.ok === true);
        const row2 = await tx.sellerProductRequest.findUnique({ where: { id: reqId }, select: { proposedName: true, proposedVariants: true } });
        // 9F-5c: proposedVariants is now { options, variants } (parseProposal
        // normalises the legacy bare-array shape too).
        ok("2 · edit persisted", row2?.proposedName === `Custom Widget ${t} v2` && parseProposal(row2?.proposedVariants).variants.length === 2);

        // 6 / 7 — cross-seller
        ok("6 · getSellerRequestForSeller(B, A's id) → null", (await getSellerRequestForSeller(ctxB, reqId, tx)) === null);
        ok("7 · updateSellerRequest(B, A's id) → NOT_FOUND", (await updateSellerRequest(ctxB, reqId, { proposedName: "x y", proposedVariants: [{ label: "d" }] }, tx)).ok === false);
        ok("7 · submitSellerRequest(B, A's id) → NOT_FOUND", (await submitSellerRequest(ctxB, reqId, tx)).ok === false);

        // 8 / 9 / 10 — images
        const aAsset = await seedAsset(tx, A.id);
        const bAsset = await seedAsset(tx, B.id);
        const attachOwn = await attachRequestImage(ctxA, reqId, aAsset.id, {}, tx);
        ok("8 · attach own MediaAsset → ok", attachOwn.ok === true);
        const attachForeign = await attachRequestImage(ctxA, reqId, bAsset.id, {}, tx);
        ok("9 · attach another seller's MediaAsset → NOT_FOUND", attachForeign.ok === false && attachForeign.code === "NOT_FOUND");
        const assetAfter = await tx.mediaAsset.findUnique({ where: { id: aAsset.id }, select: { sellerId: true, folder: true } });
        ok("10 · seller media stays seller-owned + sellers/<id>/ path", assetAfter?.sellerId === A.id && assetAfter?.folder === `sellers/${A.id}`);
        const imgCount = await tx.sellerProductRequestImage.count({ where: { requestId: reqId } });
        ok("8 · exactly one image attached", imgCount === 1);
        const imgRow = await tx.sellerProductRequestImage.findFirst({ where: { requestId: reqId }, select: { id: true } });
        ok("8 · detachRequestImage(A) → ok", (await detachRequestImage(ctxA, reqId, imgRow!.id, tx)).ok === true);

        // 11 — exact SKU duplicate blocks submission
        await updateSellerRequest(ctxA, reqId, {
          proposedName: `Custom Widget ${t} v3`,
          proposedCategoryId: category.id,
          proposedVariants: [{ label: "Clash", proposedSku: realVariant.sku }],
        }, tx);
        const blockedSubmit = await submitSellerRequest(ctxA, reqId, tx);
        ok("11 · submit blocked by an exact canonical-SKU conflict", blockedSubmit.ok === false && blockedSubmit.code === "BLOCKED" && blockedSubmit.blocks.length > 0);
        const stillDraft = await tx.sellerProductRequest.findUnique({ where: { id: reqId }, select: { status: true } });
        ok("11 · request stays DRAFT after a blocked submit", stillDraft?.status === "DRAFT");

        // 3 — DRAFT -> PENDING (fix the SKU first)
        const digits = String(Date.now()).slice(-10);
        await updateSellerRequest(ctxA, reqId, {
          proposedName: `Custom Widget ${t} final`,
          proposedCategoryId: category.id,
          barcode: digits,
          proposedVariants: [{ label: "Default" }],
        }, tx);
        const submitted = await submitSellerRequest(ctxA, reqId, tx);
        ok("3 · submitSellerRequest → ok (DRAFT → PENDING)", submitted.ok === true, JSON.stringify(submitted));
        const pending = await tx.sellerProductRequest.findUnique({ where: { id: reqId }, select: { status: true, submittedAt: true } });
        ok("3 · status PENDING + submittedAt stamped", pending?.status === "PENDING" && pending?.submittedAt != null);

        // 4 / 14 — locked after submit
        const lockedUpd = await updateSellerRequest(ctxA, reqId, { proposedName: "x y", proposedVariants: [{ label: "d" }] }, tx);
        ok("4 · updateSellerRequest on a PENDING request → LOCKED", lockedUpd.ok === false && lockedUpd.code === "LOCKED");
        const lockedImg = await attachRequestImage(ctxA, reqId, aAsset.id, {}, tx);
        ok("4 · attachRequestImage on a PENDING request → LOCKED", lockedImg.ok === false && lockedImg.code === "LOCKED");
        ok("14 · re-submitting a PENDING request is a no-op ok", (await submitSellerRequest(ctxA, reqId, tx)).ok === true);
        // manual APPROVED / REJECTED (as 9F-5c would) then confirm the seller is locked out
        await tx.sellerProductRequest.update({ where: { id: reqId }, data: { status: "REJECTED", reviewStatusNote: "nope", reviewedById: "admin-x", reviewedAt: new Date() } });
        const rejSubmit = await submitSellerRequest(ctxA, reqId, tx);
        ok("14 · a REJECTED request → submit LOCKED", rejSubmit.ok === false && rejSubmit.code === "LOCKED");
        ok("5 · seller repo has no path that sets APPROVED / REJECTED", true); // asserted statically below

        // 12 — barcode duplicate surfaced (warning)
        const bcReq = await createSellerRequest(ctxA, {
          proposedName: `Barcode Twin ${t}`,
          proposedCategoryId: category.id,
          barcode: "48210001",
          proposedVariants: [{ label: "Default" }],
        }, tx);
        if (bcReq.ok) await submitSellerRequest(ctxA, bcReq.ok ? bcReq.requestId : "", tx);
        const bcDup = await checkRequestDuplicates({ proposedName: "Something Else", barcode: "48210001", proposedVariants: [{ label: "d" }] }, {}, tx);
        ok("12 · barcode match → warning", bcDup.warnings.some((w) => w.kind === "barcode"));

        // 13 — normalized name + brand + category warning (vs a real catalog product)
        const nameDup = await checkRequestDuplicates(
          { proposedName: realProduct.name, proposedBrand: realProduct.brand, proposedCategoryId: realProduct.categoryId, proposedVariants: [{ label: "d" }] },
          {},
          tx,
        );
        ok("13 · normalized name + brand + category match → warning", nameDup.warnings.some((w) => w.kind === "name"));
        ok("13 · a clearly-novel name yields no name warning", !(await checkRequestDuplicates({ proposedName: `Zzz Novel ${t}`, proposedVariants: [{ label: "d" }] }, {}, tx)).warnings.some((w) => w.kind === "name"));

        throw new Rollback();
      },
      { timeout: 30_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = await snapshot();
  ok(
    "17-19 · Product/Variant/Category/ProductImage/ProductOption/Offer/OfferInventory/Inventory/InventoryAdjustment/StoreSetting counts unchanged",
    JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} vs ${JSON.stringify(after)}`,
  );

  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("21 · marketplace.multiSellerCheckout false/unset", (gate?.value ?? "false") !== "true");
  ok("22 · payments empty", (await prisma.payment.count()) === 0);
  ok("22 · webhookEvents empty", (await prisma.webhookEvent.count()) === 0);
}

function staticTests() {
  const repo = read("src/lib/marketplace/seller-product-request-repository.ts");
  const actions = read("src/lib/seller/product-request-actions.ts");
  const reads = read("src/lib/seller/product-requests.ts");
  const session = read("src/lib/seller/session.ts");
  const nav = read("src/lib/seller/navigation.ts");
  const catalog = read("src/lib/rbac/catalog.ts");
  const migration = read("supabase/migrations/20260904160000_seller_product_request.sql");
  const schema = read("prisma/schema.prisma");

  // 5 — seller can never set APPROVED / REJECTED
  ok("5 · request repo never writes status APPROVED / REJECTED", !/status["\s:]+["'](APPROVED|REJECTED)/.test(repo));
  ok("5 · seller actions never write status APPROVED / REJECTED", !/["'](APPROVED|REJECTED)["']/.test(actions));
  ok("5 · submit only ever sets PENDING", /data: \{ status: "PENDING"/.test(repo));

  // 15 / 16 — session gates on APPROVED seller
  ok("15/16 · getSellerSession filters sellerStatus === APPROVED", /sellerStatus === "APPROVED"/.test(session));
  ok("15/16 · every request action requires a seller session permission", (actions.match(/requireSellerSessionPermission\("manage_offers"\)/g) ?? []).length >= 5 && (actions.match(/export async function \w+Action/g) ?? []).length === (actions.match(/requireSellerSessionPermission\(/g) ?? []).length);
  ok("15/16 · no new permission introduced", !/manage_product_requests|manage_seller_catalog|request_products/.test(actions + repo + catalog));
  ok("15/16 · rbac catalog untouched by 9F-5b", !/product_request|ProductRequest/i.test(catalog));

  // 17 — no canonical catalog writes from the seller plane
  for (const [label, src] of [["request repo", repo], ["request reads", reads], ["request actions", actions]] as const) {
    ok(`17 · ${label} never writes Product/Variant/Category/ProductImage/ProductOption`, !/\b(product|variant|category|productImage|productOption|productOptionValue)\.(create|update|delete|upsert|updateMany|deleteMany)/i.test(src));
    ok(`17 · ${label} never imports @/lib/admin/catalog`, !/@\/lib\/admin\/catalog/.test(src));
  }

  // 18 / 19 — no offer / inventory writes
  ok("18/19 · request repo never writes Offer/OfferInventory/Inventory", !/\b(offer|offerInventory|offerAdjustment|inventory|inventoryAdjustment)\.(create|update|delete|upsert|updateMany)/i.test(repo));
  ok("19 · request repo never imports @/lib/inventory", !/@\/lib\/inventory/.test(repo));

  // 20 — storefront untouched
  for (const f of ["src/lib/data.ts", "src/lib/cart.ts", "src/lib/checkout.ts", "src/lib/marketplace/offer-resolver.ts"]) {
    ok(`20 · ${f} does not import the request module`, !/seller-product-request|seller\/product-request/.test(read(f)));
  }

  // media — the attach check goes through the seller-scoped media repo
  ok("media · attachRequestImage checks ownership via getSellerMedia (seller-scoped)", /getSellerMedia\(ctx, mediaAssetId/.test(repo));
  ok("media · request repo never re-scopes MediaAsset.sellerId", !/mediaAsset\.update|mediaAsset\.updateMany/.test(repo));

  // nav
  const navLine = nav.split("\n").find((l) => l.includes('"/seller/product-requests"')) ?? "";
  ok("nav · /seller/product-requests is a live route (manage_offers)", navLine.includes("live: true") && navLine.includes("manage_offers"));

  // migration — additive only
  ok(
    "migration · no destructive DDL",
    !/DROP\s+COLUMN/i.test(migration) && !/DROP\s+TABLE/i.test(migration) && !/\bTRUNCATE\b/i.test(migration) && !/\bDELETE\s+FROM\b/i.test(migration) && !/ALTER\s+TABLE\s+"(Product|Variant|Category|ProductImage)"/i.test(migration),
  );
  ok("migration · creates the two 9F-5b tables + status CHECK", /CREATE TABLE IF NOT EXISTS "SellerProductRequest"/.test(migration) && /CREATE TABLE IF NOT EXISTS "SellerProductRequestImage"/.test(migration) && /status" IN \('DRAFT', 'PENDING', 'APPROVED', 'REJECTED'\)/.test(migration));
  ok("migration · image FK → MediaAsset, request FK → Seller (Cascade)", /"SellerProductRequestImage_mediaAssetId_fkey"[\s\S]*REFERENCES "MediaAsset"/.test(migration) && /"SellerProductRequest_sellerId_fkey"[\s\S]*REFERENCES "Seller" \("id"\) ON DELETE CASCADE/.test(migration));

  // schema — no sellerId on Product / Variant
  const productBlock = schema.slice(schema.indexOf("model Product {"), schema.indexOf("model ProductImage {"));
  const variantBlock = schema.slice(schema.indexOf("model Variant {"), schema.indexOf("model Variant {") + 900);
  ok("schema · no sellerId column on Product", !/^\s*sellerId\s+String/m.test(productBlock));
  ok("schema · no sellerId column on Variant", !/^\s*sellerId\s+String/m.test(variantBlock));
  ok("schema · SellerProductRequest + SellerProductRequestImage models exist", /model SellerProductRequest \{/.test(schema) && /model SellerProductRequestImage \{/.test(schema));
}

async function main() {
  console.log("\nPHASE 9F-5b — Seller Product Request\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (rolled back)");
  await dbTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
