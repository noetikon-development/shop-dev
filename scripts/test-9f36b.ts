/**
 * PHASE 9F-36B — Seller Product Condition.
 *
 * The seller picks a Product Condition on the product-request form; it is
 * validated, persisted on `SellerProductRequest.proposedCondition`, required
 * before DRAFT → PENDING, shown read-only to the seller + the admin reviewer,
 * preserved through reopen / edit, and on approval every seeded THIRD_PARTY
 * DRAFT offer is created with it (legacy NULL → NEW). Reuses the ONE canonical
 * `Offer.condition` vocabulary (`@/lib/marketplace/conditions`) — no second enum.
 * The Axiaro FIRST_PARTY offer stays NEW. The 9F-22 ACTIVE condition-lock and
 * the `@@unique(sellerId, variantId, condition)` behaviour are unchanged.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f36b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  createSellerRequest,
  updateSellerRequest,
  submitSellerRequest,
  reopenRejectedRequest,
  getSellerRequestForSeller,
} from "@/lib/marketplace/seller-product-request-repository";
import { getAdminProductRequest, linkExistingProduct } from "@/lib/admin/seller-product-requests/repository";
import { seedSellerDraftOffers, approveByCreatingProduct } from "@/lib/admin/seller-product-requests/create-canonical";
import { createSellerOffer, updateSellerOffer, setSellerOfferStatus } from "@/lib/marketplace/seller-repository";
import { OFFER_CONDITIONS, CONDITION_OPTIONS, isOfferCondition, conditionLabel } from "@/lib/marketplace/conditions";
import type { SellerContext } from "@/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

const ctxFor = (sellerId: string): SellerContext => ({
  sellerId,
  sellerName: "S",
  sellerUserId: "su-" + sellerId,
  userId: "u-" + sellerId,
  role: "OWNER",
  permissions: new Set(),
});

async function seedSeller(tx: Tx, slug: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}
async function seedProductWithVariants(tx: Tx, categoryId: string, n = 2) {
  const t = Math.random().toString(36).slice(2, 8);
  const p = await tx.product.create({
    data: { name: `Cond ${t}`, slug: `c9f36b-${t}`, brand: "Axiaro", shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 5000 },
    select: { id: true },
  });
  const vids: string[] = [];
  for (let i = 0; i < n; i++) {
    const sku = `T36B-${t.toUpperCase()}-${i}`;
    const v = await tx.variant.create({ data: { productId: p.id, sku, price: 5000, status: "ACTIVE", stock: 0 }, select: { id: true } });
    await tx.inventory.create({ data: { variantId: v.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 } });
    vids.push(v.id);
  }
  return { productId: p.id, variantIds: vids };
}

// ─────────────────────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const conditions = read("src/lib/marketplace/conditions.ts");
  const form = read("src/components/seller/request-form.tsx");
  const actions = read("src/lib/seller/product-request-actions.ts");
  const repo = read("src/lib/marketplace/seller-product-request-repository.ts");
  const reads = read("src/lib/seller/product-requests.ts");
  const sellerPage = read("src/app/seller/(portal)/product-requests/[id]/page.tsx");
  const adminRepo = read("src/lib/admin/seller-product-requests/repository.ts");
  const adminPage = read("src/app/admin/(shell)/seller-product-requests/[id]/page.tsx");
  const createCanonical = read("src/lib/admin/seller-product-requests/create-canonical.ts");
  const adminActions = read("src/lib/admin/seller-product-requests/actions.ts");
  const schema = read("prisma/schema.prisma");
  const migration = read("supabase/migrations/20260909180000_seller_request_condition.sql");
  const pkg = read("package.json");

  // shared constant
  ok("conditions · canonical module exports OFFER_CONDITIONS / CONDITION_OPTIONS / isOfferCondition / conditionLabel",
    /export const OFFER_CONDITIONS =/.test(conditions) && /export const CONDITION_OPTIONS/.test(conditions) &&
    /export function isOfferCondition/.test(conditions) && /export function conditionLabel/.test(conditions));
  ok("conditions · the five approved values, in order", /\["\s*"NEW",\s*"REFURBISHED",\s*"OPEN_BOX",\s*"USED_LIKE_NEW",\s*"USED_GOOD",\s*\]/.test(conditions.replace(/\s+/g, " ").replace('[ "', '["')) || /OFFER_CONDITIONS = \[ "NEW", "REFURBISHED", "OPEN_BOX", "USED_LIKE_NEW", "USED_GOOD", \]/.test(conditions.replace(/\s+/g, " ")));
  ok("conditions · no duplicated inline list left in seller-repository / catalog-schemas / offer forms / offer-actions",
    !/const OFFER_CONDITIONS = \[/.test(read("src/lib/marketplace/seller-repository.ts")) &&
    !/OFFER_CONDITIONS = \[\s*\n?\s*"NEW"/.test(read("src/lib/admin/catalog-schemas.ts")) &&
    !/\{ value: "NEW", label: "New" \}/.test(read("src/components/seller/offer-create-form.tsx")) &&
    !/\{ value: "NEW", label: "New" \}/.test(read("src/components/seller/offer-edit-form.tsx")) &&
    !/z\.enum\(\["NEW", "REFURBISHED"/.test(read("src/lib/seller/offer-actions.ts")));
  ok("format.ts re-exports conditionLabel from the canonical module (no local map)",
    /export \{ conditionLabel \} from "@\/lib\/marketplace\/conditions"/.test(read("src/lib/seller/format.ts")));

  // A / B — form
  ok("A · request form renders a required Product Condition <Select name=\"proposedCondition\">",
    /Product condition/.test(form) && /name="proposedCondition"/.test(form) && /required/.test(form.slice(form.indexOf('name="proposedCondition"') - 200, form.indexOf('name="proposedCondition"') + 60)));
  ok("A · it sits right below Product name",
    form.indexOf('name="proposedName"') < form.indexOf('name="proposedCondition"') &&
    form.indexOf('name="proposedCondition"') < form.indexOf('name="proposedBrand"'));
  ok("B · the form lists all 5 conditions from the shared CONDITION_OPTIONS",
    /import \{ CONDITION_OPTIONS \} from "@\/lib\/marketplace\/conditions"/.test(form) && /CONDITION_OPTIONS\.map/.test(form));
  ok("A · default is NEW", /defaultValue=\{defaults\?\.condition \?\? "NEW"\}/.test(form));

  // actions + repo persistence
  ok("actions · reads proposedCondition from FormData + passes it through to the repo",
    /proposedCondition: s\("proposedCondition"\)/.test(actions) && /proposedCondition: parsed\.data\.proposedCondition,/.test(actions));
  ok("repo · SellerRequestInput has proposedCondition; validateInput validates against isOfferCondition",
    /proposedCondition\?: string \| null;/.test(repo) && /!isOfferCondition\(rawCondition\)/.test(repo));
  ok("repo · a partial edit that omits the field preserves the stored value (conditionProvided guard)",
    /const conditionProvided = input\.proposedCondition !== undefined;/.test(repo) &&
    /\.\.\.\(conditionProvided \? \{ proposedCondition \} : \{\}\)/.test(repo));
  ok("repo · REQUEST_SELECT returns proposedCondition", /proposedCondition: true,/.test(repo));
  ok("repo · submitSellerRequest blocks DRAFT → PENDING with the exact message, AFTER the SKU block",
    /Pick the product's condition before submitting\./.test(repo) &&
    repo.indexOf("dup.blocks.length > 0") < repo.indexOf("Pick the product's condition before submitting"));

  // read models + UI
  ok("reads · SellerRequestDetailView + getSellerRequestDetail expose `condition`",
    /condition: string \| null;/.test(reads) && /condition: r\.proposedCondition,/.test(reads));
  ok("seller [id] page · shows Condition read-only + loads it into the edit form defaults",
    /label="Condition">\{r\.condition \? conditionLabel\(r\.condition\)/.test(sellerPage) && /condition: r\.condition,/.test(sellerPage));
  ok("admin repo · AdminRequestDetail + getAdminProductRequest expose proposedCondition",
    /proposedCondition: string \| null;/.test(adminRepo) && /proposedCondition: r\.proposedCondition,/.test(adminRepo));
  ok("admin [id] page · shows 'Proposed condition' read-only (no override control)",
    /Proposed condition/.test(adminPage) && /conditionLabel\(r\.proposedCondition\)/.test(adminPage));

  // approval → offer condition
  ok("create-canonical · seedSellerDraftOffers takes a condition arg, falls back to NEW, no hard-coded 'NEW'",
    /isOfferCondition\(conditionInput\) \? conditionInput : "NEW"/.test(createCanonical) &&
    /condition, openingQuantity: 0/.test(createCanonical) &&
    !/condition: "NEW", openingQuantity: 0/.test(createCanonical));
  ok("create-canonical · linkExistingProduct + approveByCreatingProduct results carry proposedCondition",
    /proposedCondition: current\.proposedCondition,/.test(adminRepo) && /proposedCondition: req\.proposedCondition,/.test(createCanonical));
  ok("admin actions · both approve paths thread res.proposedCondition into the seeding call",
    (adminActions.match(/res\.proposedCondition,/g) ?? []).length === 2 &&
    /seedSellerDraftOffers\(sellerId, adminUserId, productId, proposedCondition\)/.test(adminActions));
  ok("FIRST_PARTY · ensureFirstPartyOffer still called with a fixed NEW (untouched by 9F-36B)",
    /ensureFirstPartyOffer\(/.test(createCanonical) && !/ensureFirstPartyOffer[\s\S]{0,200}proposedCondition/.test(createCanonical));

  // schema + migration
  ok("schema · SellerProductRequest gains nullable proposedCondition String?",
    /proposedCondition\s+String\?/.test(schema));
  ok("migration · additive ADD COLUMN IF NOT EXISTS, no DROP / DELETE / backfill",
    /ADD COLUMN IF NOT EXISTS "proposedCondition" TEXT/.test(migration) &&
    !/DROP |DELETE |UPDATE |TRUNCATE/i.test(migration.replace(/--.*$/gm, "")));
  ok("package.json · db:migrate:9f36b script points at the new migration",
    /"db:migrate:9f36b": ".*20260909180000_seller_request_condition\.sql"/.test(pkg));

  ok("scope · seed-rbac.ts not marked / touched", !/9F-36B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · checkout / settlement untouched", !/9F-36B/.test(read("src/lib/checkout.ts")) && !/9F-36B/.test(read("src/lib/marketplace/settlement.ts")));

  // pure
  ok("pure · isOfferCondition accepts the 5, rejects junk", OFFER_CONDITIONS.every(isOfferCondition) && !isOfferCondition("MINT") && !isOfferCondition(null));
  ok("pure · CONDITION_OPTIONS is the 5 {value,label} pairs in order", CONDITION_OPTIONS.length === 5 && CONDITION_OPTIONS[0].value === "NEW" && CONDITION_OPTIONS[2].value === "OPEN_BOX");
  ok("pure · conditionLabel covers all 5, echoes junk", OFFER_CONDITIONS.every((c) => conditionLabel(c) !== c) && conditionLabel("MINT") === "MINT");
}

// ─────────────────────────────────────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const adminUser = await prisma.user.findFirst({ select: { id: true } });
  const realProduct = await prisma.product.findFirst({
    where: { status: { not: "ARCHIVED" }, variants: { some: { status: "ACTIVE" } } },
    select: { id: true },
  });
  if (!category || !adminUser || !realProduct) { ok("(skipped — no catalog data / user)", true); return; }

  const before = { req: await prisma.sellerProductRequest.count(), offer: await prisma.offer.count(), product: await prisma.product.count() };
  const sfx = "9f36b-" + Date.now().toString(36);

  try {
    await prisma.$transaction(async (tx) => {
      const S = await seedSeller(tx, `s-${sfx}`);
      const ctx = ctxFor(S.id);

      // ── C — create persists proposedCondition ──
      const c1 = await createSellerRequest(ctx, { proposedName: `Widget ${sfx}`, proposedCategoryId: category.id, proposedCondition: "REFURBISHED", proposedVariants: [{ label: "Default" }] }, tx);
      ok("C · createSellerRequest → ok, condition persisted",
        c1.ok && (await tx.sellerProductRequest.findUnique({ where: { id: c1.ok ? c1.requestId : "" }, select: { proposedCondition: true } }))?.proposedCondition === "REFURBISHED");
      const rid = c1.ok ? c1.requestId : "";

      // ── D — update persists a new condition ──
      await updateSellerRequest(ctx, rid, { proposedName: `Widget ${sfx} v2`, proposedCategoryId: category.id, proposedCondition: "OPEN_BOX", proposedVariants: [{ label: "Default" }] }, tx);
      ok("D · updateSellerRequest persists the changed condition",
        (await tx.sellerProductRequest.findUnique({ where: { id: rid }, select: { proposedCondition: true } }))?.proposedCondition === "OPEN_BOX");

      // ── E — invalid condition rejected server-side ──
      const bad = await updateSellerRequest(ctx, rid, { proposedName: `Widget ${sfx} v2`, proposedCategoryId: category.id, proposedCondition: "MINT" as never, proposedVariants: [{ label: "Default" }] }, tx);
      ok("E · an unknown condition value is rejected (VALIDATION), stored value unchanged",
        !bad.ok && bad.code === "VALIDATION" &&
        (await tx.sellerProductRequest.findUnique({ where: { id: rid }, select: { proposedCondition: true } }))?.proposedCondition === "OPEN_BOX");

      // ── F — a DRAFT may be saved with NULL condition ──
      const S2 = await seedSeller(tx, `s2-${sfx}`);
      const ctx2 = ctxFor(S2.id);
      const cNull = await createSellerRequest(ctx2, { proposedName: `NoCond ${sfx}`, proposedCategoryId: category.id, proposedVariants: [{ label: "Default" }] }, tx);
      ok("F · DRAFT saves with NULL proposedCondition",
        cNull.ok && (await tx.sellerProductRequest.findUnique({ where: { id: cNull.ok ? cNull.requestId : "" }, select: { status: true, proposedCondition: true } }))?.proposedCondition == null);
      const ridNull = cNull.ok ? cNull.requestId : "";
      // a partial edit does NOT wipe / set the condition
      await updateSellerRequest(ctx2, ridNull, { proposedName: `NoCond ${sfx} v2`, proposedCategoryId: category.id, proposedVariants: [{ label: "Default" }] }, tx);
      ok("F · a partial edit (no condition field) leaves it NULL",
        (await tx.sellerProductRequest.findUnique({ where: { id: ridNull }, select: { proposedCondition: true } }))?.proposedCondition == null);

      // ── G — DRAFT cannot submit without a condition ──
      const blockedSubmit = await submitSellerRequest(ctx2, ridNull, tx);
      ok("G · submit blocked when proposedCondition is NULL — VALIDATION 'Pick the product's condition…'",
        !blockedSubmit.ok && blockedSubmit.code === "VALIDATION" && /Pick the product's condition/.test(blockedSubmit.error));
      ok("G · request stays DRAFT after the blocked submit",
        (await tx.sellerProductRequest.findUnique({ where: { id: ridNull }, select: { status: true } }))?.status === "DRAFT");

      // ── H — with a valid condition, submit succeeds ──
      await updateSellerRequest(ctx2, ridNull, { proposedName: `NoCond ${sfx} v2`, proposedCategoryId: category.id, proposedCondition: "USED_GOOD", proposedVariants: [{ label: "Default" }] }, tx);
      const goodSubmit = await submitSellerRequest(ctx2, ridNull, tx);
      ok("H · submit succeeds once a valid condition is set (DRAFT → PENDING)",
        goodSubmit.ok && (await tx.sellerProductRequest.findUnique({ where: { id: ridNull }, select: { status: true } }))?.status === "PENDING");

      // ── I — seller request read returns the condition (REQUEST_SELECT → SellerRequestDetailView.condition) ──
      const detail = await getSellerRequestForSeller(ctx2, ridNull, tx);
      ok("I · the seller-scoped request read returns proposedCondition", detail?.proposedCondition === "USED_GOOD");

      // ── J — admin review returns the condition ──
      const adminDetail = await getAdminProductRequest(ridNull, tx);
      ok("J · getAdminProductRequest returns proposedCondition", adminDetail?.proposedCondition === "USED_GOOD");

      // ── K — reopen preserves the condition ──
      await tx.sellerProductRequest.update({ where: { id: ridNull }, data: { status: "REJECTED", reviewStatusNote: "Photos unclear.", reviewedById: adminUser.id, reviewedAt: new Date() } });
      const reopened = await reopenRejectedRequest(ctx2, ridNull, tx);
      ok("K · reopen (REJECTED → DRAFT) preserves proposedCondition",
        reopened.ok && (await tx.sellerProductRequest.findUnique({ where: { id: ridNull }, select: { status: true, proposedCondition: true } }))?.proposedCondition === "USED_GOOD");

      // ── L — edit + resubmit preserves it (partial edit) ──
      await updateSellerRequest(ctx2, ridNull, { proposedName: `NoCond ${sfx} v3`, proposedCategoryId: category.id, proposedVariants: [{ label: "Default" }] }, tx);
      ok("L · a partial edit after reopen keeps the condition (preserve-on-omit)",
        (await tx.sellerProductRequest.findUnique({ where: { id: ridNull }, select: { proposedCondition: true } }))?.proposedCondition === "USED_GOOD");
      const resub = await submitSellerRequest(ctx2, ridNull, tx);
      ok("L · resubmit still succeeds (condition carried through)", resub.ok === true);

      // ── M — approval seeds every THIRD_PARTY DRAFT offer with proposedCondition ──
      const { productId, variantIds } = await seedProductWithVariants(tx, category.id, 3);
      const S3 = await seedSeller(tx, `s3-${sfx}`);
      const reqM = await tx.sellerProductRequest.create({
        data: { sellerId: S3.id, status: "PENDING", proposedName: `Link ${sfx}`, proposedCondition: "REFURBISHED", submittedAt: new Date() },
        select: { id: true },
      });
      const linkRes = await linkExistingProduct(reqM.id, productId, adminUser.id, null, tx);
      ok("M · linkExistingProduct result carries the proposedCondition",
        linkRes.ok && linkRes.proposedCondition === "REFURBISHED");
      const seeded = await seedSellerDraftOffers(S3.id, adminUser.id, productId, linkRes.ok ? linkRes.proposedCondition : null, tx);
      ok("M · every seeded offer is DRAFT / THIRD_PARTY / condition REFURBISHED",
        seeded.created.length === 3 && seeded.condition === "REFURBISHED" &&
        (await tx.offer.findMany({ where: { sellerId: S3.id }, select: { status: true, condition: true } }))
          .every((o) => o.status === "DRAFT" && o.condition === "REFURBISHED"));
      void variantIds;

      // ── N — legacy NULL condition → seeded offers fall back to NEW ──
      const { productId: pidN } = await seedProductWithVariants(tx, category.id, 2);
      const S4 = await seedSeller(tx, `s4-${sfx}`);
      const reqN = await tx.sellerProductRequest.create({
        data: { sellerId: S4.id, status: "PENDING", proposedName: `Legacy ${sfx}`, submittedAt: new Date() },
        select: { id: true, proposedCondition: true },
      });
      ok("N · a request with no proposedCondition reads back NULL", reqN.proposedCondition == null);
      const seededN = await seedSellerDraftOffers(S4.id, adminUser.id, pidN, reqN.proposedCondition, tx);
      ok("N · NULL → seeded offers default to NEW",
        seededN.condition === "NEW" &&
        (await tx.offer.findMany({ where: { sellerId: S4.id }, select: { condition: true } })).every((o) => o.condition === "NEW"));

      // ── O — the Axiaro FIRST_PARTY offer stays NEW ──
      const S5 = await seedSeller(tx, `s5-${sfx}`);
      const reqO = await tx.sellerProductRequest.create({
        data: { sellerId: S5.id, status: "PENDING", proposedName: `Create ${sfx}`, proposedCondition: "OPEN_BOX", submittedAt: new Date() },
        select: { id: true },
      });
      const createdProd = await approveByCreatingProduct(reqO.id, adminUser.id, {
        name: `Curated ${sfx}`, slug: `curated-${sfx}`, brand: "Axiaro",
        shortDescription: "short", description: "long description",
        categoryId: category.id, price: 149900, sku: `CUR-${sfx}`,
        options: [],
      }, tx);
      ok("O · approveByCreatingProduct → ok, result carries proposedCondition OPEN_BOX",
        createdProd.ok && createdProd.proposedCondition === "OPEN_BOX");
      if (createdProd.ok) {
        const vIds = (await tx.variant.findMany({ where: { productId: createdProd.productId }, select: { id: true } })).map((x) => x.id);
        const fp = await tx.offer.findFirst({ where: { variantId: { in: vIds }, seller: { is: { type: "FIRST_PARTY" } } }, select: { condition: true } });
        ok("O · the FIRST_PARTY (1P) offer is condition NEW regardless of the seller's proposal", fp?.condition === "NEW");
      }

      // ── P — @@unique(sellerId, variantId, condition): an existing (variant, condition) offer is skipped ──
      const { productId: pidP, variantIds: vidsP } = await seedProductWithVariants(tx, category.id, 2);
      const S6 = await seedSeller(tx, `s6-${sfx}`);
      await createSellerOffer(ctxFor(S6.id), { variantId: vidsP[0], price: 5000, condition: "OPEN_BOX" }, tx);
      const seededP = await seedSellerDraftOffers(S6.id, adminUser.id, pidP, "OPEN_BOX", tx);
      ok("P · seeding skips the variant the seller already lists in that condition (1 created, 1 skipped)",
        seededP.created.length === 1 && seededP.skipped === 1 &&
        (await tx.offer.count({ where: { sellerId: S6.id, condition: "OPEN_BOX" } })) === 2);

      // ── Q — the 9F-22 ACTIVE condition-lock is unchanged ──
      const { variantIds: vidsQ } = await seedProductWithVariants(tx, category.id, 1);
      const S7 = await seedSeller(tx, `s7-${sfx}`);
      const ctx7 = ctxFor(S7.id);
      const offQ = await createSellerOffer(ctx7, { variantId: vidsQ[0], price: 5000, condition: "NEW", openingQuantity: 5 }, tx);
      const offId = offQ.ok ? offQ.offerId : "";
      ok("Q · a DRAFT seeded/created offer's condition CAN be changed (before publish)",
        (await updateSellerOffer(ctx7, offId, { condition: "REFURBISHED" }, tx)).ok === true);
      const goLive = await setSellerOfferStatus(ctx7, offId, "ACTIVE", tx);
      ok("Q · precondition — the offer is ACTIVE", goLive.ok === true, JSON.stringify(goLive));
      const activeEdit = await updateSellerOffer(ctx7, offId, { condition: "OPEN_BOX" }, tx);
      ok("Q · once ACTIVE, changing the condition is REJECTED (9F-22 lock intact)",
        !activeEdit.ok && activeEdit.code === "VALIDATION" && /inactive before changing its condition/.test(activeEdit.error));
      ok("Q · the ACTIVE offer's condition is unchanged after the rejected attempt",
        (await tx.offer.findUnique({ where: { id: offId }, select: { condition: true } }))?.condition === "REFURBISHED");

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · no SellerProductRequest leaked", (await prisma.sellerProductRequest.count()) === before.req);
  ok("rollback · no Offer leaked", (await prisma.offer.count()) === before.offer);
  ok("rollback · no Product leaked", (await prisma.product.count()) === before.product);
}

async function main() {
  console.log("\nPHASE 9F-36B — Seller Product Condition\n");
  staticTests();
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
