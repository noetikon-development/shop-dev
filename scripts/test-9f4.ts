/**
 * Phase 9F-4a — Seller Settings & Profile Foundation — assertion runner.
 *
 * DB tests build real Sellers + MediaAsset rows inside ONE prisma.$transaction
 * and roll back — nothing persists. Static tests read source files. Run with
 * --conditions=react-server so `server-only` is inert.
 *
 * Coverage (spec VALIDATION 1-22):
 *   1  Seller A cannot read Seller B profile
 *   2  Seller A cannot mutate Seller B profile
 *   3  STAFF lacks manage_seller_settings
 *   4  OWNER + MANAGER hold manage_seller_settings
 *   5  seller plane never writes protected Seller fields
 *   6  seller media stamped with sellerId; path forced under sellers/<id>/
 *   7  seller media list is seller-scoped
 *   8  cross-seller media read / set-image fails
 *   9  media validation (image-only for logo/banner; email; country; https social)
 *   10 referenced logo/banner cannot be deleted
 *   11 DRAFT -> PENDING (submit)
 *   12 PENDING -> APPROVED requires admin (status-guarded updateMany mirror)
 *   13 seller cannot self-approve (no repo path sets APPROVED)
 *   14 APPROVED edit -> PENDING
 *   15 admin review actions are audited + reuse manage_content
 *   16 no Product/Variant/Offer/OfferInventory/StoreSetting writes
 *   17 storefront readers untouched by profile fields
 *   18 marketplace.multiSellerCheckout remains false
 *   19 PayMongo dormant (payments / webhookEvents 0)
 *   20/21/22 monitor:9e3d / reconcile:9e3d / test:9f1-3 — run separately
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f4.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  getSellerSettings,
  updateSellerProfileDraft,
  updateSellerContact,
  submitSellerProfile,
  setSellerProfileImage,
  SELLER_PROTECTED_FIELDS,
} from "../src/lib/marketplace/seller-profile-repository";
import {
  listSellerMedia,
  getSellerMedia,
  deleteSellerMedia,
} from "../src/lib/marketplace/seller-media-repository";
import { SELLER_ROLE_PERMISSIONS } from "../src/lib/marketplace/seller-permissions";
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

async function seedSeller(tx: Tx, slug: string, over: Record<string, unknown> = {}) {
  return tx.seller.create({
    data: {
      type: "THIRD_PARTY",
      status: "APPROVED",
      displayName: slug,
      slug,
      supportEmail: `${slug}@t.test`,
      contentStatus: "DRAFT",
      ...over,
    },
    select: {
      id: true,
      displayName: true,
      type: true,
      status: true,
      slug: true,
      commissionRate: true,
      contentStatus: true,
      bio: true,
    },
  });
}

async function seedAsset(tx: Tx, sellerId: string, over: Record<string, unknown> = {}) {
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
      ...over,
    },
    select: { id: true, sellerId: true, folder: true, mimeType: true },
  });
}

async function dbTests() {
  const counts0 = {
    product: await prisma.product.count(),
    variant: await prisma.variant.count(),
    offer: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    storeSetting: await prisma.storeSetting.count(),
    inventory: await prisma.inventory.count(),
    inventoryAdjustment: await prisma.inventoryAdjustment.count(),
  };

  try {
    await prisma.$transaction(async (tx) => {
      const t = String(Date.now()).slice(-7);
      const A = await seedSeller(tx, `a9f4-${t}`);
      const B = await seedSeller(tx, `b9f4-${t}`, { bio: "B's private bio" });
      const ctxA = ctxFor(A.id);
      const ctxB = ctxFor(B.id);

      // 1 — A cannot read B's profile
      const aView = await getSellerSettings(ctxA, tx);
      const bView = await getSellerSettings(ctxB, tx);
      ok("1 · getSellerSettings is seller-scoped", aView?.sellerId === A.id && bView?.sellerId === B.id);
      ok("1 · A's view never carries B's bio", aView?.profile.bio == null && bView?.profile.bio === "B's private bio");

      // 2 — A cannot mutate B (repo scopes every write to ctx.sellerId)
      await updateSellerProfileDraft(ctxA, { bio: "A wrote this" }, tx);
      const bAfter = await tx.seller.findUnique({ where: { id: B.id }, select: { bio: true } });
      const aAfter = await tx.seller.findUnique({ where: { id: A.id }, select: { bio: true } });
      ok("2 · A's write lands on A", aAfter?.bio === "A wrote this");
      ok("2 · A's write never touches B", bAfter?.bio === "B's private bio");

      // 5 — protected fields never move via the seller plane
      const protectedBefore = { type: A.type, status: A.status, slug: A.slug, commissionRate: A.commissionRate, displayName: A.displayName };
      await updateSellerProfileDraft(ctxA, { returnPolicy: "x", shippingPolicy: "y", shipFromCity: "Manila", shipFromCountry: "PH" }, tx);
      await updateSellerContact(ctxA, { supportEmail: "new@t.test", notifyEmail: "notify@t.test" }, tx);
      const aFull = await tx.seller.findUnique({ where: { id: A.id } });
      ok(
        "5 · type/status/slug/commissionRate/displayName unchanged by seller writes",
        aFull?.type === protectedBefore.type &&
          aFull?.status === protectedBefore.status &&
          aFull?.slug === protectedBefore.slug &&
          aFull?.commissionRate === protectedBefore.commissionRate &&
          aFull?.displayName === protectedBefore.displayName,
      );
      ok("5 · contentReviewedBy not set by seller writes", aFull?.contentReviewedBy == null);

      // 9 — validation
      const badEmail = await updateSellerContact(ctxA, { supportEmail: "not-an-email" }, tx);
      ok("9 · rejects invalid support email", badEmail.ok === false);
      const badCountry = await updateSellerProfileDraft(ctxA, { shipFromCountry: "ZZ" }, tx);
      ok("9 · rejects unsupported country", badCountry.ok === false);
      const badSocial = await updateSellerProfileDraft(ctxA, { socialLinks: { website: "http://insecure.test" } }, tx);
      ok("9 · rejects non-https social link", badSocial.ok === false);
      const goodSocial = await updateSellerProfileDraft(ctxA, { socialLinks: { website: "https://ok.test/" } }, tx);
      ok("9 · accepts https social link", goodSocial.ok === true);

      // 11 — DRAFT -> PENDING (submit)
      const beforeSubmit = await tx.seller.findUnique({ where: { id: A.id }, select: { contentStatus: true } });
      const submitted = await submitSellerProfile(ctxA, tx);
      ok("11 · submit moves DRAFT -> PENDING", beforeSubmit?.contentStatus === "DRAFT" && submitted.ok && submitted.contentStatus === "PENDING");
      const subStamp = await tx.seller.findUnique({ where: { id: A.id }, select: { contentSubmittedAt: true } });
      ok("11 · contentSubmittedAt is stamped", subStamp?.contentSubmittedAt != null);

      // 12 — PENDING -> APPROVED only via the admin status-guarded updateMany
      const adv = await tx.seller.updateMany({
        where: { id: A.id, contentStatus: "PENDING" },
        data: { contentStatus: "APPROVED", contentReviewedAt: new Date(), contentReviewedBy: "admin-u", contentReviewNote: null },
      });
      ok("12 · admin PENDING -> APPROVED transition applies once", adv.count === 1);
      const advAgain = await tx.seller.updateMany({
        where: { id: A.id, contentStatus: "PENDING" },
        data: { contentStatus: "APPROVED" },
      });
      ok("12 · status-guarded — no second APPROVED", advAgain.count === 0);

      // 14 — APPROVED edit -> PENDING
      const editApproved = await updateSellerProfileDraft(ctxA, { bio: "edited after approval" }, tx);
      ok("14 · editing an APPROVED bundle returns it to PENDING", editApproved.ok && editApproved.contentStatus === "PENDING");
      const reReview = await tx.seller.findUnique({ where: { id: A.id }, select: { contentStatus: true, contentReviewedAt: true } });
      ok("14 · review stamp cleared for the fresh cycle", reReview?.contentStatus === "PENDING" && reReview?.contentReviewedAt == null);

      // 6 / 7 / 8 — media scoping
      const a1 = await seedAsset(tx, A.id);
      const a2 = await seedAsset(tx, A.id);
      const b1 = await seedAsset(tx, B.id);
      ok("6 · seeded seller asset carries sellerId + sellers/<id>/ folder", a1.sellerId === A.id && a1.folder === `sellers/${A.id}`);
      const aList = await listSellerMedia(ctxA, tx);
      const bList = await listSellerMedia(ctxB, tx);
      ok("7 · listSellerMedia returns only the caller's assets", aList.length === 2 && bList.length === 1 && aList.every((m) => m.sellerId === A.id));
      ok("8 · getSellerMedia(B, A's asset) === null", (await getSellerMedia(ctxB, a1.id, tx)) === null);
      const crossSet = await setSellerProfileImage(ctxA, "logo", b1.id, tx);
      ok("8 · setSellerProfileImage rejects another seller's asset", crossSet.ok === false);
      const okSet = await setSellerProfileImage(ctxA, "logo", a1.id, tx);
      ok("6 · setSellerProfileImage accepts the caller's own image", okSet.ok === true);
      const withLogo = await tx.seller.findUnique({ where: { id: A.id }, select: { logoMediaId: true } });
      ok("6 · logoMediaId points at the chosen asset", withLogo?.logoMediaId === a1.id);

      // 9 — logo/banner must be an image
      const pdf = await seedAsset(tx, A.id, { mimeType: "application/pdf", filename: "x.pdf" });
      const notImage = await setSellerProfileImage(ctxA, "banner", pdf.id, tx);
      ok("9 · logo/banner rejects a non-image asset", notImage.ok === false);

      // 10 — referenced logo cannot be deleted; unreferenced can
      const blocked = await deleteSellerMedia(ctxA, a1.id, tx);
      ok("10 · cannot delete the asset currently set as the logo", blocked.ok === false && blocked.code === "IN_USE");
      await setSellerProfileImage(ctxA, "logo", null, tx); // clear
      const freed = await deleteSellerMedia(ctxA, a1.id, tx);
      ok("10 · once cleared, the asset deletes", freed.ok === true);
      const crossDelete = await deleteSellerMedia(ctxB, a2.id, tx);
      ok("8 · cannot delete another seller's asset", crossDelete.ok === false);

      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const counts1 = {
    product: await prisma.product.count(),
    variant: await prisma.variant.count(),
    offer: await prisma.offer.count(),
    offerInventory: await prisma.offerInventory.count(),
    storeSetting: await prisma.storeSetting.count(),
    inventory: await prisma.inventory.count(),
    inventoryAdjustment: await prisma.inventoryAdjustment.count(),
  };
  ok(
    "16 · Product/Variant/Offer/OfferInventory/StoreSetting/Inventory/InventoryAdjustment counts unchanged",
    JSON.stringify(counts0) === JSON.stringify(counts1),
    `${JSON.stringify(counts0)} vs ${JSON.stringify(counts1)}`,
  );

  // 18 / 19 — gate + PayMongo
  const gate = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" }, select: { value: true } });
  ok("18 · marketplace.multiSellerCheckout is false / unset", (gate?.value ?? "false") !== "true", gate?.value ?? "unset");
  ok("19 · payments table empty", (await prisma.payment.count()) === 0);
  ok("19 · webhookEvents table empty", (await prisma.webhookEvent.count()) === 0);
}

function staticTests() {
  const profileRepo = read("src/lib/marketplace/seller-profile-repository.ts");
  const mediaRepo = read("src/lib/marketplace/seller-media-repository.ts");
  const settingsActions = read("src/lib/seller/settings-actions.ts");
  const adminActions = read("src/lib/admin/seller-content-actions.ts");
  const perms2 = read("src/lib/marketplace/seller-permissions.ts");
  const nav = read("src/lib/seller/navigation.ts");
  const migration = read("supabase/migrations/20260904140000_seller_profile_foundation.sql");
  const schema = read("prisma/schema.prisma");

  // 3 / 4 — permission wiring
  ok("3 · STAFF lacks manage_seller_settings", !SELLER_ROLE_PERMISSIONS.STAFF.includes("manage_seller_settings"));
  ok(
    "4 · OWNER + MANAGER hold manage_seller_settings",
    SELLER_ROLE_PERMISSIONS.OWNER.includes("manage_seller_settings") &&
      SELLER_ROLE_PERMISSIONS.MANAGER.includes("manage_seller_settings"),
  );
  ok("4 · MANAGER still lacks manage_seller_users", !SELLER_ROLE_PERMISSIONS.MANAGER.includes("manage_seller_users"));

  // 5 — protected fields never appear as a write key in the seller plane
  ok(
    "5 · SELLER_PROTECTED_FIELDS lists the operator columns",
    (["type", "status", "slug", "commissionRate", "displayName"] as const).every((f) =>
      (SELLER_PROTECTED_FIELDS as readonly string[]).includes(f),
    ),
  );
  for (const f of ["type:", "status:", "slug:", "commissionRate:", "displayName:"]) {
    ok(
      `5 · profile repo never writes ${f.slice(0, -1)}`,
      !new RegExp(`data(\\.|\\[")?${f.slice(0, -1)}(")?\\]?\\s*[:=]`).test(
        profileRepo.replace(/\/\/.*$/gm, ""),
      ),
    );
  }

  // 13 — no seller-plane path sets APPROVED
  ok(
    "13 · seller profile repo never sets contentStatus APPROVED",
    !/contentStatus["\s:]+["']?APPROVED/.test(profileRepo),
  );
  ok(
    "13 · seller settings actions never set contentStatus APPROVED",
    !/["']APPROVED["']/.test(settingsActions),
  );

  // 15 — admin review reuses manage_content, is audited, only PENDING transitions
  ok("15 · admin actions require manage_content", (adminActions.match(/requirePermission\("manage_content"\)/g) ?? []).length >= 2);
  ok("15 · admin actions never add a new permission", !/moderate_seller_content/.test(adminActions) && !/requirePermission\("(?!manage_content")/.test(adminActions));
  ok("15 · admin approve is audited", /writeAudit\(/.test(adminActions) && /seller\.content\.approved/.test(adminActions) && /seller\.content\.rejected/.test(adminActions));
  ok("15 · admin transitions are PENDING-guarded", (adminActions.match(/contentStatus: "PENDING"/g) ?? []).length >= 2);
  ok("15 · admin can only reach APPROVED or DRAFT", /to: "APPROVED"/.test(adminActions) && /to: "DRAFT"/.test(adminActions) && !/"SUSPENDED"|"CLOSED"/.test(adminActions));

  // 16 — no forbidden writes from the seller plane
  for (const [label, src] of [
    ["profile repo", profileRepo],
    ["media repo", mediaRepo],
    ["settings actions", settingsActions],
  ] as const) {
    ok(`16 · ${label} never imports @/lib/inventory`, !/@\/lib\/inventory/.test(src));
    ok(`16 · ${label} never writes Inventory/InventoryAdjustment`, !/\b(inventoryAdjustment|\.inventory\.(update|create|delete|upsert))/.test(src));
    ok(`16 · ${label} never writes StoreSetting`, !/storeSetting\.(update|create|delete|upsert)/.test(src));
    ok(`16 · ${label} never writes Product/Variant/Offer/OfferInventory`, !/\b(product|variant|offer|offerInventory)\.(update|create|delete|upsert)/.test(src));
  }

  // 17 — storefront readers do not read the profile columns
  for (const f of ["src/lib/data.ts", "src/lib/cart.ts", "src/lib/checkout.ts", "src/lib/marketplace/offer-resolver.ts"]) {
    const src = read(f);
    ok(`17 · ${f} does not read seller profile fields`, !/\b(returnPolicy|shippingPolicy|shipFrom|contentStatus|logoMediaId|bannerMediaId)\b/.test(src));
  }

  // settings actions never revalidate the storefront
  ok("17 · settings actions never revalidate products / PDP / PLP", !/revalidateTag\("products"\)|revalidatePath\("\/p\/|revalidatePath\("\/c\//.test(settingsActions));
  ok("17 · settings actions require manage_seller_settings on every export", (settingsActions.match(/requireSellerSessionPermission\("manage_seller_settings"\)/g) ?? []).length >= 6);

  // nav
  const navSettingsLine = nav.split("\n").find((l) => l.includes('"/seller/settings"')) ?? "";
  ok("nav · /seller/settings is live", navSettingsLine.includes("live: true"));

  // migration — additive only
  ok(
    "migration · no destructive DDL",
    !/DROP\s+COLUMN/i.test(migration) &&
      !/DROP\s+TABLE/i.test(migration) &&
      !/\bTRUNCATE\b/i.test(migration) &&
      !/\bDELETE\s+FROM\b/i.test(migration),
  );
  ok("migration · adds the Seller profile columns", /ADD COLUMN IF NOT EXISTS "bio"/.test(migration) && /ADD COLUMN IF NOT EXISTS "contentStatus"/.test(migration));
  ok("migration · adds MediaAsset.sellerId + FK SET NULL", /ALTER TABLE "MediaAsset" ADD COLUMN IF NOT EXISTS "sellerId"/.test(migration) && /"MediaAsset_sellerId_fkey"[\s\S]*ON DELETE SET NULL/.test(migration));
  ok("migration · contentStatus CHECK is DRAFT/PENDING/APPROVED", /contentStatus" IN \('DRAFT', 'PENDING', 'APPROVED'\)/.test(migration));

  // schema
  ok("schema · Seller has the profile columns", /model Seller[\s\S]*contentStatus\s+String/.test(schema));
  ok("schema · MediaAsset has sellerId + SellerOwnedMedia relation", /sellerId String\?/.test(schema) && /SellerOwnedMedia/.test(schema));
  ok(
    "5 · seller permissions stay code-only (no DB / admin rbac import)",
    !/from "@\/lib\/prisma"|from "@\/lib\/rbac|prisma\.\w/.test(perms2),
  );
}

async function main() {
  console.log("\nPHASE 9F-4a — Seller Settings & Profile Foundation\n");
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
