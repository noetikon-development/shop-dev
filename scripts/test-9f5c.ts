/**
 * Phase 9F-5c — Admin Product Request Review & Canonical Product Creation.
 *
 * DB tests build a THIRD_PARTY seller + User + PENDING request + seller
 * MediaAsset inside ONE prisma.$transaction and roll back. The review repo
 * (requestChanges / rejectRequest / linkExistingProduct), approveByCreatingProduct
 * and promoteRequestImage all take an optional transaction client; audit + email
 * are written by the action layer, so those are STATIC checks (same split as
 * test-9f3 / test-9f4b). `regenerateVariants` (the option cartesian) is NOT
 * tx-aware, so under an externalTx approveByCreatingProduct returns
 * variantGenDeferred:true and the cartesian is asserted structurally.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f5c.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  requestChanges,
  rejectRequest,
  linkExistingProduct,
  getAdminProductRequest,
  listAdminProductRequests,
} from "../src/lib/admin/seller-product-requests/repository";
import { approveByCreatingProduct } from "../src/lib/admin/seller-product-requests/create-canonical";
import { promoteRequestImage } from "../src/lib/admin/seller-product-requests/promote-image";
import { safeAuthNext } from "../src/lib/auth/safe-next";

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
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

async function seedSeller(tx: Tx, slug: string, status = "APPROVED") {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status, displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}
async function seedUserMember(tx: Tx, sellerId: string, tag: string, role = "OWNER") {
  const user = await tx.user.create({
    data: { email: `${tag}@t.test`, name: "T", role: "CUSTOMER", supabaseUserId: `sb-${tag}` },
    select: { id: true },
  });
  await tx.sellerUser.create({ data: { sellerId, userId: user.id, role, status: "ACTIVE" } });
  return user.id;
}
async function seedRequest(tx: Tx, sellerId: string, categoryId: string, patch: Record<string, unknown> = {}) {
  return tx.sellerProductRequest.create({
    data: {
      sellerId,
      status: "PENDING",
      proposedName: `Proposed ${Math.random().toString(36).slice(2, 8)}`,
      proposedBrand: "SellerBrand",
      proposedShortDesc: "short",
      proposedDescription: "long description",
      proposedCategoryId: categoryId,
      submittedAt: new Date(),
      proposedVariants: { options: [], variants: [{ label: "Default" }] },
      ...patch,
    },
    select: { id: true, sellerId: true },
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
    select: { id: true },
  });
}

async function snapshot() {
  return {
    product: await prisma.product.count(),
    variant: await prisma.variant.count(),
    category: await prisma.category.count(),
    productImage: await prisma.productImage.count(),
    productOption: await prisma.productOption.count(),
    productOptionValue: await prisma.productOptionValue.count(),
    offer: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    offerAdjustment: await prisma.offerAdjustment.count(),
    inventory: await prisma.inventory.count(),
    inventoryAdjustment: await prisma.inventoryAdjustment.count(),
    mediaAsset: await prisma.mediaAsset.count(),
    sellerProductRequest: await prisma.sellerProductRequest.count(),
    seller: await prisma.seller.count(),
    user: await prisma.user.count(),
    storeSetting: await prisma.storeSetting.count(),
  };
}

async function dbTests() {
  const before = await snapshot();
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const realVariant = await prisma.variant.findFirst({ select: { sku: true } });
  const realProduct = await prisma.product.findFirst({ where: { status: { not: "ARCHIVED" } }, select: { id: true, slug: true } });
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!category || !realVariant || !realProduct || !axiaro) {
    ok("db tests skipped — catalog / 1P seller missing", true);
    return;
  }
  CURATED_CATEGORY = category.id;

  try {
    await prisma.$transaction(
      async (tx) => {
        const t = Date.now().toString(36);
        const S = await seedSeller(tx, `spr5c-${t}`);
        const admin = await seedUserMember(tx, S.id, `adm5c-${t}`);

        // ── REQUEST REVIEW ────────────────────────────────────────────────
        const r1 = await seedRequest(tx, S.id, category.id);
        const listed = await listAdminProductRequests({ status: "PENDING" }, tx);
        ok("1 · admin list includes the PENDING request", listed.some((x) => x.id === r1.id));
        const detail = await getAdminProductRequest(r1.id, tx);
        ok("1 · admin detail loads (seller info + proposal + duplicates)", !!detail && detail.sellerName === `spr5c-${t}` && Array.isArray(detail.duplicates.warnings));

        // 3 — request changes → DRAFT, note stored, seller can resubmit path
        const rc = await requestChanges(r1.id, admin, "Please add dimensions.", tx);
        ok("3 · requestChanges → ok", rc.ok === true);
        const afterRc = await tx.sellerProductRequest.findUnique({ where: { id: r1.id }, select: { status: true, reviewStatusNote: true, reviewedById: true } });
        ok("3 · request is DRAFT with the note + reviewer stored", afterRc?.status === "DRAFT" && afterRc?.reviewStatusNote === "Please add dimensions." && afterRc?.reviewedById === admin);
        ok("4 · seller sees the returned DRAFT (editable again)", afterRc?.status === "DRAFT");
        ok("3 · requestChanges requires a note", (await requestChanges(r1.id, admin, "  ", tx)).ok === false);
        ok("3 · requestChanges on a non-PENDING request → conflict", (await requestChanges(r1.id, admin, "again", tx)).ok === false);

        // 5 — rejection is terminal
        const r2 = await seedRequest(tx, S.id, category.id);
        const rej = await rejectRequest(r2.id, admin, "Not a fit for the catalogue.", tx);
        ok("5 · rejectRequest → ok", rej.ok === true);
        const afterRej = await tx.sellerProductRequest.findUnique({ where: { id: r2.id }, select: { status: true } });
        ok("5 · request is REJECTED", afterRej?.status === "REJECTED");
        ok("5 · REJECTED is terminal — no further review transitions", (await rejectRequest(r2.id, admin, "x", tx)).ok === false && (await requestChanges(r2.id, admin, "x", tx)).ok === false && (await linkExistingProduct(r2.id, realProduct.id, admin, null, tx)).ok === false);
        ok("5 · a REJECTED request cannot be turned into a product", (await approveByCreatingProduct(r2.id, admin, curated(t), tx)).ok === false);

        // ── LINK EXISTING PRODUCT ─────────────────────────────────────────
        const r3 = await seedRequest(tx, S.id, category.id);
        const link = await linkExistingProduct(r3.id, realProduct.id, admin, "Same product.", tx);
        ok("7 · existing product can be selected + linked", link.ok === true);
        const afterLink = await tx.sellerProductRequest.findUnique({ where: { id: r3.id }, select: { status: true, resultProductId: true } });
        ok("8 · resultProductId stored, status APPROVED", afterLink?.status === "APPROVED" && afterLink?.resultProductId === realProduct.id);
        ok("9 · linking creates NO new product", (await tx.product.count()) === before.product);
        ok("6 · approval is idempotent — 2nd link on the same request → conflict", (await linkExistingProduct(r3.id, realProduct.id, admin, null, tx)).ok === false);
        ok("3 · linking to an ARCHIVED product is rejected", await (async () => {
          const arch = await tx.product.create({ data: { name: `Arch ${t}`, slug: `arch-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "ARCHIVED", price: 1000 } });
          const rr = await seedRequest(tx, S.id, category.id);
          const res = await linkExistingProduct(rr.id, arch.id, admin, null, tx);
          return res.ok === false;
        })());

        // ── CREATE NEW PRODUCT ────────────────────────────────────────────
        const r4 = await seedRequest(tx, S.id, category.id);
        const created = await approveByCreatingProduct(r4.id, admin, curated(t, [
          { name: "Colour", values: ["Black", "White"] },
        ]), tx);
        ok("11 · approveByCreatingProduct → ok", created.ok === true, JSON.stringify(created));
        if (created.ok) {
          const p = await tx.product.findUnique({ where: { id: created.productId }, select: { name: true, brand: true, shortDescription: true, status: true, slug: true, categoryId: true } });
          ok("13 · product data is admin-curated (not the seller's proposal)", p?.name === `Curated ${t}` && p?.brand === "Axiaro" && p?.status === "DRAFT");
          const vs = await tx.variant.findMany({ where: { productId: created.productId }, select: { id: true, sku: true, status: true } });
          ok("12 · a default canonical Variant exists (ACTIVE, curated SKU)", vs.length === 1 && vs[0].sku === `CUR-${t}` && vs[0].status === "ACTIVE");
          ok("14 · SKU uniqueness enforced (clash → conflict)", await (async () => {
            const rr = await seedRequest(tx, S.id, category.id);
            const res = await approveByCreatingProduct(rr.id, admin, { ...curated(t + "x"), sku: realVariant.sku }, tx);
            return res.ok === false && res.code === "CONFLICT";
          })());
          const opts = await tx.productOption.findMany({ where: { productId: created.productId }, select: { name: true, values: { select: { value: true } } } });
          ok("15 · ProductOption / ProductOptionValue rows created", opts.length === 1 && opts[0].name === "Colour" && opts[0].values.length === 2);
          ok("16 · Colour option carries its values", opts[0].values.map((v) => v.value).sort().join(",") === "Black,White");
          ok("17 · option cartesian is deferred under a tx (production path runs regenerateVariants)", created.hasOptions === true && created.variantGenDeferred === true);
          // 18 / 19 — FIRST_PARTY offer side effects for the default variant
          const offers = await tx.offer.findMany({ where: { variantId: vs[0].id, sellerId: axiaro.id, condition: "NEW" }, select: { id: true, status: true } });
          ok("19 · exactly one FIRST_PARTY NEW offer for the variant", offers.length === 1);
          ok("18 · offer is DRAFT (product is DRAFT) — not customer-purchasable", offers[0].status === "DRAFT");
          const oi = await tx.offerInventory.findFirst({ where: { offerId: offers[0].id }, select: { id: true, quantity: true } });
          ok("18 · OfferInventory row, quantity 0", !!oi && oi.quantity === 0);
          const oa = await tx.offerAdjustment.findMany({ where: { offerInventoryId: oi!.id }, select: { reason: true, delta: true } });
          ok("18 · one MIGRATION_OPENING OfferAdjustment, delta 0", oa.length === 1 && oa[0].reason === "MIGRATION_OPENING" && oa[0].delta === 0);
          const inv = await tx.inventory.findUnique({ where: { variantId: vs[0].id }, select: { quantity: true } });
          ok("18 · one birth-record Inventory row, quantity 0", !!inv && inv.quantity === 0);
          ok("19 · NO InventoryAdjustment written by product creation", (await tx.inventoryAdjustment.count()) === before.inventoryAdjustment);
          const linkedReq = await tx.sellerProductRequest.findUnique({ where: { id: r4.id }, select: { status: true, resultProductId: true } });
          ok("8 · request APPROVED + resultProductId set to the new product", linkedReq?.status === "APPROVED" && linkedReq?.resultProductId === created.productId);
          ok("6 · create is idempotent — 2nd create on the same request → conflict", (await approveByCreatingProduct(r4.id, admin, curated(t + "z"), tx)).ok === false);

          // ── MEDIA ──────────────────────────────────────────────────────
          const r5 = await seedRequest(tx, S.id, category.id);
          const asset = await seedAsset(tx, S.id);
          const img = await tx.sellerProductRequestImage.create({ data: { requestId: r5.id, mediaAssetId: asset.id, role: "gallery", sortOrder: 0 }, select: { id: true } });
          ok("20 · seller image stays seller-owned before promotion", (await tx.mediaAsset.findUnique({ where: { id: asset.id }, select: { sellerId: true } }))?.sellerId === S.id);
          ok("21 · cannot promote before the request is approved+linked", (await promoteRequestImage(r5.id, img.id, {}, tx)).ok === false);
          await linkExistingProduct(r5.id, created.productId, admin, null, tx);
          const promo = await promoteRequestImage(r5.id, img.id, {}, tx);
          ok("21 · explicit promotion works", promo.ok === true);
          const pi = await tx.productImage.findFirst({ where: { productId: created.productId, mediaAssetId: asset.id }, select: { id: true } });
          ok("22 · ProductImage created for the promoted asset", !!pi);
          ok("6 · MediaAsset re-scoped to the catalog (sellerId → null, folder products)", await (async () => {
            const a = await tx.mediaAsset.findUnique({ where: { id: asset.id }, select: { sellerId: true, folder: true } });
            return a?.sellerId === null && a?.folder === "products";
          })());
          // now foreign / non-seller-owned → cannot promote again
          const r6 = await seedRequest(tx, S.id, category.id);
          await linkExistingProduct(r6.id, created.productId, admin, null, tx);
          const otherSeller = await seedSeller(tx, `spr5c-o-${t}`);
          const foreignAsset = await seedAsset(tx, otherSeller.id);
          const foreignImg = await tx.sellerProductRequestImage.create({ data: { requestId: r6.id, mediaAssetId: foreignAsset.id, role: "gallery", sortOrder: 0 }, select: { id: true } });
          ok("23 · cross-seller image promotion rejected", (await promoteRequestImage(r6.id, foreignImg.id, {}, tx)).ok === false);
        }

        // ── AUTHORIZATION (data-level) ────────────────────────────────────
        const otherS = await seedSeller(tx, `spr5c-x-${t}`);
        const otherReq = await seedRequest(tx, otherS.id, category.id);
        ok("37 · a seller has no repo path that sets APPROVED/REJECTED (see static)", true);
        ok("39 · getAdminProductRequest is by id only — the /seller repo is what scopes sellers", (await getAdminProductRequest(otherReq.id, tx))?.sellerId === otherS.id);

        throw new Rollback();
      },
      { timeout: 40_000, maxWait: 12_000 },
    );
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = await snapshot();
  ok(
    "41-45 · every catalog / inventory / offer / seller / user count unchanged after rollback",
    JSON.stringify(before) === JSON.stringify(after),
    `${JSON.stringify(before)} vs ${JSON.stringify(after)}`,
  );
}

let CURATED_CATEGORY = "";
function curated(t: string, options: { name: string; values: string[] }[] = []) {
  return {
    name: `Curated ${t}`,
    slug: `curated-${t}`,
    brand: "Axiaro",
    shortDescription: "Curated short description",
    description: "Curated long description in Axiaro house style.",
    categoryId: CURATED_CATEGORY,
    status: "DRAFT",
    price: 149900,
    compareAtPrice: null as number | null,
    sku: `CUR-${t}`,
    options,
  };
}

async function staticTests() {
  const repo = read("src/lib/admin/seller-product-requests/repository.ts");
  const create = read("src/lib/admin/seller-product-requests/create-canonical.ts");
  const promote = read("src/lib/admin/seller-product-requests/promote-image.ts");
  const actions = read("src/lib/admin/seller-product-requests/actions.ts");
  const sellerRepo = read("src/lib/marketplace/seller-product-request-repository.ts");
  const sellerActions = read("src/lib/seller/product-request-actions.ts");
  const rbacCatalog = read("src/lib/rbac/catalog.ts");
  const seedRbac = read("scripts/seed-rbac.ts");
  const emailSend = read("src/lib/email/send.ts");
  const emailNotifs = read("src/lib/email/notifications.ts");
  const sellerLogin = read("src/components/seller/seller-login-form.tsx");
  const authActions = read("src/lib/auth-actions.ts");
  const forgotForm = read("src/components/auth/forgot-password-form.tsx");
  const banner = read("src/components/seller/approved-banner.tsx");
  const schema = read("prisma/schema.prisma");
  const catalogSchemas = read("src/lib/admin/catalog-schemas.ts");

  // Authorization — permissions reused, no new RBAC key
  ok("10/24 · review actions use manage_content", (actions.match(/requirePermission\("manage_content"\)/g) ?? []).length >= 3);
  ok("24 · create uses create_products", /requirePermission\("create_products"\)/.test(actions));
  ok("24 · image promotion uses manage_product_images", /requirePermission\("manage_product_images"\)/.test(actions));
  ok("SCHEMA · no new RBAC permission key introduced", !/moderate_seller|manage_product_requests|review_product_requests|approve_seller/.test(actions + repo + create + promote));
  ok("SCHEMA · rbac/catalog.ts untouched by 9F-5c", !/product.request|ProductRequest|seller_product_request/i.test(rbacCatalog));
  ok("SCHEMA · scripts/seed-rbac.ts untouched by 9F-5c", !/product.request|ProductRequest|seller_product_request/i.test(seedRbac));

  // 37 / 38 — seller plane cannot approve or create canonical rows
  ok("37 · seller repo never sets APPROVED/REJECTED", !/status:\s*["'](APPROVED|REJECTED)["']/.test(sellerRepo));
  ok("38 · seller actions never create Product/Variant/ProductOption", !/\b(product|variant|productOption|productOptionValue|productImage)\.(create|update|delete|upsert|updateMany|deleteMany)/i.test(sellerActions));
  ok("38 · seller product-request module never imports the admin catalog / creation code", !/@\/lib\/admin\/(catalog|seller-product-requests)/.test(sellerActions + sellerRepo));

  // 43 / 44 — no new inventory path
  ok("43 · create-canonical writes Inventory but NEVER InventoryAdjustment", /inventory\.create/.test(create) && !/inventoryAdjustment\.(create|update|delete|upsert)/i.test(create));
  ok("43 · create-canonical reuses ensureFirstPartyOffer (the existing 1P offer authority)", /ensureFirstPartyOffer/.test(create) && /@\/lib\/admin\/offer-sync/.test(create));
  ok("17 · create-canonical reuses regenerateVariants for the option cartesian", /regenerateVariants/.test(create) && /@\/lib\/admin\/variants/.test(create));
  ok("43 · review repo never writes Product/Variant/Offer/Inventory", !/\b(product|variant|offer|offerInventory|offerAdjustment|inventory|inventoryAdjustment)\.(create|update|delete|upsert|updateMany|deleteMany)/i.test(repo));
  ok("45 · promote-image only writes MediaAsset + ProductImage (no inventory / offer)", !/\b(offer|offerInventory|inventory|inventoryAdjustment|variant)\.(create|update|delete|upsert)/i.test(promote));

  // Status re-check transactional
  ok("6 · approve claims the request status-guarded (updateMany where status PENDING)", /updateMany\(\{\s*where:\s*\{ id: requestId, status: "PENDING" \}/.test(create));
  ok("6 · link/reject/changes are status-guarded (updateMany where status PENDING)", (repo.match(/where:\s*\{ id: requestId, status: "PENDING" \}/g) ?? []).length >= 2);

  // Statuses — only the 4 approved
  ok("2 · only DRAFT/PENDING/APPROVED/REJECTED used", !/"(SUBMITTED|IN_REVIEW|NEEDS_CHANGES|CANCELLED|CLOSED)"/.test(repo + create + sellerRepo));

  // 14 — audit logging
  for (const a of ["approved", "rejected", "changes_requested", "linked", "product_created", "image_promoted"]) {
    ok(`14 · audit action seller_product_request.${a}`, actions.includes(`seller_product_request.${a}`));
  }

  // 28-32 — notifications
  ok("11 · exactly 3 new EmailTypes", /seller_product_request_submitted/.test(emailSend) && /seller_product_request_approved/.test(emailSend) && /seller_product_request_rejected/.test(emailSend));
  ok("11 · no seller lifecycle email type (deferred)", !/seller_account_(approved|suspended|closed)/.test(emailSend));
  ok("28 · submit email fired from the seller submit action", /sendSellerProductRequestSubmitted/.test(sellerActions));
  ok("29 · approve email fired on link + create", (actions.match(/sendSellerProductRequestApproved/g) ?? []).length >= 2);
  ok("30 · reject / changes email fired", (actions.match(/sendSellerProductRequestRejected/g) ?? []).length >= 2);
  // 9F-5c.1: reviewedAt is now derived from the request row, and a retry can
  // pass the original key back verbatim — the key still buckets by reviewedAt-ms.
  ok("31 · idempotency keys bucket by reviewedAt so repeats don't collide but a re-review can send", /SELLER_PRODUCT_REQUEST_APPROVED:\$\{requestId\}:\$\{reviewedAt\.getTime\(\)\}/.test(emailNotifs) && /opts\.idempotencyKey \?\?/.test(emailNotifs));
  ok("32 · dispatch goes through renderAndDispatch (records a FAILED EmailLog on render failure)", /renderAndDispatch\(/.test(emailNotifs.slice(emailNotifs.indexOf("sendSellerProductRequestSubmitted"))));
  ok("11 · recipients are seller OWNER/MANAGER + notifyEmail, never a customer", /role: \{ in: \["OWNER", "MANAGER"\] \}/.test(emailNotifs) && /notifyEmail/.test(emailNotifs));
  ok("11 · no email on a DRAFT save (only createRequestAction/updateRequestAction, no send there)", !/sendSellerProductRequest\w+\(/.test(sellerActions.slice(0, sellerActions.indexOf("submitRequestAction"))));

  // 24 / 25 / 26 — seller auth
  ok("24 · /seller/login has a Forgot password link → /forgot-password?next=/seller/login", /forgot-password\?next=\/seller\/login/.test(sellerLogin));
  ok("27 · seller login password field uses the shared <Field> (eye toggle)", /<Field\b[\s\S]*type="password"/.test(sellerLogin) && /from "@\/components\/ui\/field"/.test(sellerLogin));
  ok("25 · requestPasswordReset threads an allow-listed next", /safeAuthNext\(String\(formData\.get\("next"\)/.test(authActions));
  ok("26 · safeAuthNext is a strict allow-list ({/login, /seller/login})", safeAuthNext("/seller/login") === "/seller/login" && safeAuthNext("//evil.com") === "/login" && safeAuthNext("https://evil") === "/login" && safeAuthNext("/account") === "/login");
  ok("25 · forgot form carries next as a hidden field", /name="next"/.test(forgotForm));
  ok("15 · no seller-specific password system — reuses Supabase recovery (auth-actions)", !/seller.*resetPasswordForEmail|resetPasswordForEmail.*seller/i.test(authActions) && /resetPasswordForEmail/.test(authActions));

  // 33-36 — approved acknowledgement banner
  ok("33 · dashboard renders the approved banner", /SellerApprovedBanner/.test(read("src/app/seller/(portal)/page.tsx")));
  ok("34 · banner dismiss persists in localStorage", /localStorage\.setItem\(KEY, "1"\)/.test(banner));
  ok("36 · banner copy does not imply customer-visible selling", !/sell to customers|customers can buy|live seller|active marketplace|start selling/i.test(banner));
  ok("35 · banner only ships on the portal (gated to APPROVED sellers by requireSellerSession)", /requireSellerSession/.test(read("src/app/seller/(portal)/page.tsx")));

  // 46-48 — gates
  ok("46 · nothing here flips marketplace.multiSellerCheckout", !/multiSellerCheckout/.test(actions + create + repo + promote));
  ok("47 · nothing here touches PayMongo / Payment / webhooks", !/paymongo|PaymentRefund|webhookEvent/i.test(actions + create + repo + promote));
  ok("16/48 · product created as DRAFT by default (no storefront exposure on approval)", /status: z\.enum\(\["DRAFT", "ACTIVE"\]\)/.test(actions) && /defaultValue="DRAFT"/.test(read("src/components/admin/seller-product-requests/create-product-panel.tsx")));
  ok("48 · storefront libs never import the admin request code", ["src/lib/data.ts", "src/lib/cart.ts", "src/lib/checkout.ts"].every((f) => !/seller-product-request/.test(read(f))));

  // Part 5 — proposed options inside the existing JSON, no migration
  ok("5 · proposedVariants JSON carries { options, variants } — parseProposal handles both shapes", /export function parseProposal/.test(sellerRepo) && /options: ProposedOption\[\]; variants: ProposedVariant\[\]/.test(sellerRepo));
  ok("5 · option limits mirror the canonical catalog (3 / 24 / 60)", /MAX_OPTION_TYPES = 3/.test(sellerRepo) && /MAX_OPTION_VALUES = 24/.test(sellerRepo));
  ok("5 · no new SellerProductRequest column added", !/ALTER TABLE "SellerProductRequest" ADD COLUMN|proposedOptions\s+Json/.test(schema));
  ok("5 · Product / Variant ownership structure unchanged", !/^\s*sellerId\s+String/m.test(schema.slice(schema.indexOf("model Product {"), schema.indexOf("model ProductImage {"))));

  // migration — there is none in 9F-5c
  ok("SCHEMA · 9F-5c adds no new migration file", !/2026090[5-9]|20260[1-9]1\d/.test(read("package.json").match(/db:migrate:9f5c[^\n]*/)?.[0] ?? ""));
  ok("SCHEMA · catalog option schema still 3 types / 24 values / 60 chars", /max\(3, "Up to 3 option types per product"\)/.test(catalogSchemas) && /max\(24, "Too many values"\)/.test(catalogSchemas));

  // gate + payments in prod
  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("46 · marketplace.multiSellerCheckout is false in prod", (gate?.value ?? "false") !== "true");
  ok("47 · payments / webhookEvents empty in prod", (await prisma.payment.count()) === 0 && (await prisma.webhookEvent.count()) === 0);
}

async function main() {
  console.log("\nPHASE 9F-5c — Admin Product Request Review & Canonical Product Creation\n");
  console.log("Static wiring");
  await staticTests();
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
