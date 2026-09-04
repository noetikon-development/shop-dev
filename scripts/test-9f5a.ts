/**
 * Phase 9F-5a — Seller Catalog Listing UX Polish — assertion runner.
 *
 * DB tests build a real ACTIVE Product+Variant and an ARCHIVED one, plus two
 * sellers, inside ONE prisma.$transaction and roll back. The seller read models
 * + Offer repo functions take an optional transaction client. Static tests read
 * source files. Run with --conditions=react-server.
 *
 * Coverage (spec VALIDATION 1-25; 19-25 run as separate npm scripts):
 *   1  "Listings" terminology
 *   2  Add Listing entry point
 *   3  catalog search works
 *   4  category browse works
 *   5  product/variant selection works
 *   6  duplicate Offer prevention still works
 *   7  archived Product/Variant cannot be newly listed
 *   8  all supported conditions exposed
 *   9  Offer creation remains DRAFT
 *   10 seller can edit its own Offer
 *   11 cross-seller Offer mutation fails
 *   12 seller cannot modify canonical Product/Variant
 *   13 3P ACTIVE gating remains enforced
 *   14 marketplace.multiSellerCheckout false
 *   15 customer storefront unchanged
 *   16 PayMongo dormant
 *   17 OfferInventory authoritative
 *   18 1P inventory unchanged
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f5a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  findListableVariants,
  listListingCategories,
  getListableVariantState,
} from "../src/lib/seller/offers";
import {
  createSellerOffer,
  updateSellerOffer,
  setSellerOfferStatus,
} from "../src/lib/marketplace/seller-repository";
import { listSellerOffersForAdmin } from "../src/lib/admin/sellers/repository";
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

async function seedSeller(tx: Tx, slug: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}

async function seedProduct(tx: Tx, name: string, categoryId: string, status: "ACTIVE" | "ARCHIVED", variantStatus: "ACTIVE" | "ARCHIVED" = "ACTIVE") {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Math.random().toString(36).slice(2, 6);
  const p = await tx.product.create({
    data: {
      name, slug, brand: "Axiaro", shortDescription: "s", description: "d", categoryId, status, price: 5000,
    },
    select: { id: true },
  });
  const sku = `T9F5A-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const v = await tx.variant.create({
    data: { productId: p.id, sku, price: 5000, status: variantStatus, stock: 0 },
    select: { id: true },
  });
  await tx.inventory.create({ data: { variantId: v.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 } });
  return { productId: p.id, variantId: v.id, name, sku };
}

async function snapshot() {
  return {
    product: await prisma.product.count(),
    variant: await prisma.variant.count(),
    inventory: await prisma.inventory.count(),
    inventoryAdjustment: await prisma.inventoryAdjustment.count(),
    storeSetting: await prisma.storeSetting.count(),
  };
}

async function dbTests() {
  const before = await snapshot();
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true, name: true } });
  if (!category) {
    ok("db tests skipped — no active category", true);
    return;
  }

  try {
    await prisma.$transaction(
      async (tx) => {
        const t = Date.now().toString(36);
        const A = await seedSeller(tx, `a95a-${t}`);
        const B = await seedSeller(tx, `b95a-${t}`);
        const ctxA = ctxFor(A.id);
        const ctxB = ctxFor(B.id);

        const live = await seedProduct(tx, `ListTest Widget ${t}`, category.id, "ACTIVE");
        const archProduct = await seedProduct(tx, `Archived Prod ${t}`, category.id, "ARCHIVED");
        const archVariant = await seedProduct(tx, `Archived Variant ${t}`, category.id, "ACTIVE", "ARCHIVED");

        // 3 — search
        const bySearch = await findListableVariants(ctxA, { q: `ListTest Widget ${t}` }, tx);
        ok("3 · catalog search finds the live variant", bySearch.some((v) => v.variantId === live.variantId));
        ok("3 · search result carries the canonical category + SKU", bySearch[0]?.categoryName === category.name && bySearch[0]?.sku === live.sku);

        // 4 — category browse
        const cats = await listListingCategories(tx);
        ok("4 · listListingCategories returns the category with a product", cats.some((c) => c.id === category.id && c.productCount > 0));
        const byCat = await findListableVariants(ctxA, { categoryId: category.id, limit: 50 }, tx);
        ok("4 · category browse surfaces the live variant", byCat.some((v) => v.variantId === live.variantId));

        // 5 — selection
        const sel = await getListableVariantState(ctxA, live.variantId, tx);
        ok("5 · getListableVariantState resolves a live variant → ok", sel.state === "ok" && sel.state === "ok" && sel.sku === live.sku);
        ok("5 · selection identifies the canonical product (name + slug + category)", sel.state === "ok" && sel.productName === live.name && Boolean(sel.productSlug) && sel.categoryName === category.name);
        ok("5 · takenConditions starts empty", sel.state === "ok" && sel.takenConditions.length === 0);

        // 7 — archived cannot be newly listed
        const arch1 = await getListableVariantState(ctxA, archProduct.variantId, tx);
        const arch2 = await getListableVariantState(ctxA, archVariant.variantId, tx);
        ok("7 · archived product → state 'archived'", arch1.state === "archived");
        ok("7 · archived variant → state 'archived'", arch2.state === "archived");
        ok("7 · archived product/variant excluded from search", !(await findListableVariants(ctxA, { q: `Archived` }, tx)).some((v) => v.variantId === archProduct.variantId || v.variantId === archVariant.variantId));
        const archCreate = await createSellerOffer(ctxA, { variantId: archProduct.variantId, price: 4000 }, tx);
        ok("7 · createSellerOffer rejects an archived product", archCreate.ok === false);
        const archVCreate = await createSellerOffer(ctxA, { variantId: archVariant.variantId, price: 4000 }, tx);
        ok("7 · createSellerOffer rejects an archived variant", archVCreate.ok === false);

        // 9 — creation is DRAFT
        const made = await createSellerOffer(ctxA, { variantId: live.variantId, price: 4500, condition: "NEW", openingQuantity: 7, reorderPoint: 2, handlingTimeDays: 3 }, tx);
        ok("9 · createSellerOffer succeeds", made.ok === true);
        const offerRow = made.ok ? await tx.offer.findUnique({ where: { id: made.offerId }, select: { status: true, condition: true } }) : null;
        ok("9 · new listing is DRAFT", offerRow?.status === "DRAFT");
        ok("8 · condition persisted from the form (NEW)", offerRow?.condition === "NEW");

        // 6 — duplicate prevention
        const dupe = await createSellerOffer(ctxA, { variantId: live.variantId, price: 4000, condition: "NEW" }, tx);
        ok("6 · duplicate (seller,variant,NEW) → rejected", dupe.ok === false && dupe.code === "CONFLICT");
        const otherCondition = await createSellerOffer(ctxA, { variantId: live.variantId, price: 4200, condition: "REFURBISHED" }, tx);
        ok("8 · a second condition (REFURBISHED) on the same variant is allowed", otherCondition.ok === true);
        const selAfter = await getListableVariantState(ctxA, live.variantId, tx);
        ok("8 · getListableVariantState now reports NEW + REFURBISHED as taken", selAfter.state === "ok" && selAfter.takenConditions.sort().join(",") === "NEW,REFURBISHED");
        ok("6 · findListableVariants(NEW) now excludes the listed variant", !(await findListableVariants(ctxA, { q: `ListTest Widget ${t}`, condition: "NEW" }, tx)).some((v) => v.variantId === live.variantId));

        // 10 — seller edits its own offer
        if (made.ok) {
          ok("10 · seller can edit its own listing", (await updateSellerOffer(ctxA, made.offerId, { price: 4600 }, tx)).ok === true);
          // 11 — cross-seller
          ok("11 · updateSellerOffer(B, A's offer) → NOT_FOUND", (await updateSellerOffer(ctxB, made.offerId, { price: 1 }, tx)).ok === false);
          ok("11 · setSellerOfferStatus(B, A's offer) → NOT_FOUND", (await setSellerOfferStatus(ctxB, made.offerId, "INACTIVE", tx)).ok === false);
          // 13 — ACTIVE gating
          const goLive = await setSellerOfferStatus(ctxA, made.offerId, "ACTIVE", tx);
          ok("13 · setSellerOfferStatus → ACTIVE refused while the gate is off", goLive.ok === false && goLive.code === "FORBIDDEN");
          // lifecycle still works
          ok("10 · DRAFT → INACTIVE works", (await setSellerOfferStatus(ctxA, made.offerId, "INACTIVE", tx)).ok === true);

          // 12 — admin read-only listings panel
          const adminRows = await listSellerOffersForAdmin(A.id, {}, tx);
          ok("12 · listSellerOffersForAdmin returns A's listings", adminRows.length === 2 && adminRows.every((r) => typeof r.available === "number" && !("action" in r)));
          ok("12 · admin panel scoped to the seller", (await listSellerOffersForAdmin(B.id, {}, tx)).length === 0);
        }

        // 17 — the create wrote OfferInventory, not Inventory
        if (made.ok) {
          const oi = await tx.offerInventory.findUnique({ where: { offerId: made.offerId }, select: { quantity: true } });
          ok("17 · listing stock lives in OfferInventory (qty 7)", oi?.quantity === 7);
          const inv = await tx.inventory.findUnique({ where: { variantId: live.variantId }, select: { quantity: true } });
          ok("17 · canonical Inventory for the variant stays 0", inv?.quantity === 0);
        }

        throw new Rollback();
      },
      { timeout: 25_000, maxWait: 10_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = await snapshot();
  ok("18 · Product/Variant/Inventory/InventoryAdjustment/StoreSetting counts unchanged", JSON.stringify(before) === JSON.stringify(after), `${JSON.stringify(before)} vs ${JSON.stringify(after)}`);

  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("14 · marketplace.multiSellerCheckout false/unset", (gate?.value ?? "false") !== "true");
  ok("16 · payments empty", (await prisma.payment.count()) === 0);
  ok("16 · webhookEvents empty", (await prisma.webhookEvent.count()) === 0);
}

function staticTests() {
  const nav = read("src/lib/seller/navigation.ts");
  const offersPage = read("src/app/seller/(portal)/offers/page.tsx");
  const newPage = read("src/app/seller/(portal)/offers/new/page.tsx");
  const detailPage = read("src/app/seller/(portal)/offers/[id]/page.tsx");
  const dash = read("src/app/seller/(portal)/page.tsx");
  const createForm = read("src/components/seller/offer-create-form.tsx");
  const offersLib = read("src/lib/seller/offers.ts");
  const adminRepo = read("src/lib/admin/sellers/repository.ts");
  const adminDetail = read("src/app/admin/(shell)/sellers/[id]/page.tsx");

  // 1 — terminology
  ok('1 · nav route labelled "Listings"', /path: "\/seller\/offers", label: "Listings"/.test(nav));
  ok('1 · nav route path is still /seller/offers', /"\/seller\/offers"/.test(nav) && !/"\/seller\/listings"/.test(nav));
  ok('1 · crumb labels use Listings / Add listing', /offers: "Listings"/.test(nav) && /new: "Add listing"/.test(nav));
  ok('1 · offers list page titled "Listings"', /title: "Listings"/.test(offersPage) && /title="Listings"/.test(offersPage));
  ok('1 · no "My Offers" string remains in the seller portal', !/My Offers/.test(nav + offersPage + newPage + detailPage + dash));
  ok('1 · dashboard says "Recent listings" / "Total listings"', /Recent listings/.test(dash) && /Total listings/.test(dash));

  // 2 — Add Listing entry point
  ok('2 · "Add listing" button on the list page + dashboard', /Add listing/.test(offersPage) && /Add listing/.test(dash));
  ok("2 · new page is the Add-listing screen", /title: "Add listing"/.test(newPage) && /findListableVariants/.test(newPage) && /listListingCategories/.test(newPage));

  // 4 — category browse wired
  ok("4 · new page renders category browse", /Browse categories/.test(newPage) && /\?category=/.test(newPage));
  ok("4 · findListableVariants accepts categoryId", /categoryId\?: string/.test(offersLib) && /categoryWithDescendants/.test(offersLib));

  // 7 — archived read-only state
  ok('7 · new page handles the "archived" state read-only', /v\.state === "archived"/.test(newPage) && /can&rsquo;t create a listing/.test(newPage));
  ok("7 · getListableVariantState returns not_found | archived | ok", /state: "not_found"/.test(offersLib) && /state: "archived"/.test(offersLib) && /state: "ok"/.test(offersLib));

  // 8 — all conditions
  ok("8 · create form exposes all four conditions", /NEW/.test(createForm) && /REFURBISHED/.test(createForm) && /USED_LIKE_NEW/.test(createForm) && /USED_GOOD/.test(createForm));
  ok("8 · create form disables already-listed conditions", /takenConditions/.test(createForm) && /disabled=\{taken\.has/.test(createForm));

  // 12 — 3P ACTIVE gate unchanged (do not re-implement)
  ok("13 · seller-repository still blocks THIRD_PARTY → ACTIVE on the gate", /marketplace\.multiSellerCheckout/.test(read("src/lib/marketplace/seller-repository.ts")) && /code: "FORBIDDEN"/.test(read("src/lib/marketplace/seller-repository.ts")));

  // 12 — canonical immutability
  ok("12 · seller offers lib never writes Product/Variant/Category", !/\b(product|variant|category|productImage|productOption)\.(create|update|delete|upsert|updateMany)/i.test(offersLib));
  ok("12 · seller offers lib never imports @/lib/admin", !/@\/lib\/admin/.test(offersLib));
  for (const f of ["src/lib/seller/offer-actions.ts", "src/lib/seller/offers.ts", "src/components/seller/offer-create-form.tsx"]) {
    ok(`12 · ${f} — no canonical catalog write`, !/prisma\.(product|variant|category|productImage)\.(create|update|delete)/i.test(read(f)));
  }

  // 12 (admin panel) — read-only
  ok("12 · listSellerOffersForAdmin is read-only (findMany, no write)", /\.offer\.findMany/.test(adminRepo.slice(adminRepo.indexOf("listSellerOffersForAdmin"))) && !/listSellerOffersForAdmin[\s\S]{0,900}\.(update|create|delete|updateMany)/.test(adminRepo));
  ok("12 · admin panel reads OfferInventory, not Variant.stock", /listSellerOffersForAdmin[\s\S]{0,900}inventory: \{ select/.test(adminRepo) && !/listSellerOffersForAdmin[\s\S]{0,900}stock: true/.test(adminRepo));
  ok('12 · admin detail page renders the "Listings" panel labelled read-only', /listSellerOffersForAdmin/.test(adminDetail) && /read-only/.test(adminDetail));
  ok("12 · admin listings panel has no mutation form/action", !/listings\.map[\s\S]{0,600}(action=|onSubmit=|<form)/.test(adminDetail));

  // 15 — storefront untouched
  for (const f of ["src/lib/data.ts", "src/lib/cart.ts", "src/lib/checkout.ts", "src/lib/marketplace/offer-resolver.ts"]) {
    ok(`15 · ${f} does not import the seller listing module`, !/@\/lib\/seller\/offers/.test(read(f)));
  }

  // 17 — OfferInventory authority
  ok("17 · seller offer repo never imports @/lib/inventory", !/@\/lib\/inventory/.test(read("src/lib/marketplace/seller-repository.ts")));

  // no schema change
  // 9F-5a itself made no schema change; its guarantee is that canonical
  // ownership is untouched — assert no sellerId lands on Product / Variant.
  const _schema = read("prisma/schema.prisma");
  const _productBlock = _schema.slice(_schema.indexOf("model Product {"), _schema.indexOf("model ProductImage {"));
  ok("schema · no sellerId column on Product (canonical ownership unchanged)", !/^\s*sellerId\s+String/m.test(_productBlock));
}

async function main() {
  console.log("\nPHASE 9F-5a — Seller Catalog Listing UX Polish\n");
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
