/**
 * PHASE 9F-24A — 3P offer activation (publish).
 *
 * `setSellerOfferStatus` now accepts `→ ACTIVE`, keeping the 9F-8c double-lock
 * (marketplace flag + transition map) AND adding a publish-readiness check:
 * seller APPROVED · Product ACTIVE · Variant ACTIVE · OfferInventory available
 * > 0. `setOfferStatusAction`'s zod enum now includes ACTIVE; the seller offer
 * page renders "Publish listing" / the blocking reasons.
 *
 * DB tests build a THIRD_PARTY seller + product + variant + offer inside ONE
 * prisma.$transaction and roll back. `setSellerOfferStatus` takes the tx client
 * (`externalTx`). The live `marketplace.multiSellerCheckout` is `"true"` in this
 * environment, so the flag-open path is exercised directly; the flag-CLOSED
 * case is covered by the pure `offerPublishBlockers` unit + a static assertion
 * (flipping the production setting is out of scope).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f24a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  setSellerOfferStatus,
  offerPublishBlockers,
  OFFER_PUBLISH_BLOCKER_MESSAGE,
} from "@/lib/marketplace/seller-repository";
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

const ctxFor = (sellerId: string): SellerContext => ({
  sellerId,
  sellerName: "T",
  sellerUserId: "su",
  userId: "u",
  role: "OWNER" as SellerContext["role"],
  permissions: new Set(["manage_offers"]),
});

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const repo = read("src/lib/marketplace/seller-repository.ts");
  const actions = read("src/lib/seller/offer-actions.ts");
  const controls = read("src/components/seller/offer-status-controls.tsx");
  const page = read("src/app/seller/(portal)/offers/[id]/page.tsx");

  ok("action · statusSchema enum now includes ACTIVE",
    /status: z\.enum\(\["DRAFT", "ACTIVE", "INACTIVE", "ARCHIVED"\]\)/.test(actions));
  ok("action · publishes revalidate the storefront only when storefrontAffected",
    /if \(res\.storefrontAffected\) \{\s*\n\s*revalidateTag\("products", "max"\);\s*\n\s*revalidateTag\("categories", "max"\);\s*\n\s*\}/.test(actions));
  ok("repo · setSellerOfferStatus keeps the flag gate as the FIRST check (double-lock, unchanged wording)",
    /if \(next === "ACTIVE"\) \{\s*\n\s*const gate = await getStoreSetting\("marketplace\.multiSellerCheckout"\);\s*\n\s*if \(gate !== "true"\) \{[\s\S]{0,120}code: "FORBIDDEN",\s*\n\s*error: OFFER_PUBLISH_BLOCKER_MESSAGE\.MARKETPLACE_CLOSED,/.test(repo) &&
    repo.indexOf('const gate = await getStoreSetting("marketplace.multiSellerCheckout")') < repo.indexOf("const allowed: Record"));
  ok("repo · transition map unchanged (DRAFT/INACTIVE→ACTIVE, ACTIVE→INACTIVE/ARCHIVED, no ARCHIVED row)",
    /DRAFT: \["INACTIVE", "ARCHIVED", "ACTIVE"\],\s*\n\s*INACTIVE: \["DRAFT", "ARCHIVED", "ACTIVE"\],\s*\n\s*ACTIVE: \["INACTIVE", "ARCHIVED"\],/.test(repo));
  ok("repo · readiness check runs inside the tx, only for next === ACTIVE",
    /if \(next === "ACTIVE"\) \{[\s\S]{0,400}offerPublishBlockers\(\{[\s\S]{0,300}\}\);\s*\n\s*if \(blockers\.length > 0\)/.test(repo));
  ok("repo · ARCHIVED still rejected before the readiness check",
    /if \(offer\.status === "ARCHIVED"\) \{\s*\n\s*return \{ ok: false, code: "VALIDATION", error: "An archived offer can't be reactivated\." \};/.test(repo));
  ok("component · Publish listing button submits ACTIVE",
    /onClick=\{\(\) => submit\("ACTIVE"\)\}[\s\S]{0,200}Publish listing/.test(controls));
  ok("component · blockers list shown when canPublish is false", /const canPublish = blockers\.length === 0;/.test(controls));
  ok("component · ARCHIVED remains terminal", /if \(status === "ARCHIVED"\) \{\s*\n\s*return <p[^>]*>This listing is archived and can’t be changed\.<\/p>;/.test(controls));
  ok("page · computes the same publish blockers + passes them to the control",
    /offerPublishBlockers\(\{[\s\S]{0,300}\}\)\.map\(\(b\) => OFFER_PUBLISH_BLOCKER_MESSAGE\[b\]\)/.test(page) &&
    /blockers=\{publishBlockerMessages\}/.test(page));
  ok("page · stale 'opens in a later marketplace phase' copy removed",
    !/opens in a later marketplace phase/.test(page));
  ok("page · ACTIVE offer is described as visible to buyers, not hidden",
    /isLive \? "visible to buyers on the storefront" : "not visible to buyers"/.test(page));

  // scope
  ok("scope · checkout / buy-box / 1P offer-sync / seed-rbac untouched",
    !/9F-24A/.test(read("src/lib/checkout.ts")) && !/9F-24A/.test(read("src/lib/marketplace/buy-box-rule.ts")) &&
    !/9F-24A/.test(read("src/lib/admin/offer-sync.ts")) && !/9F-24A/.test(read("scripts/seed-rbac.ts")));
  ok("scope · proposal approval (create-canonical) untouched", !/9F-24A/.test(read("src/lib/admin/seller-product-requests/create-canonical.ts")));
  ok("scope · no schema change", !/9F-24A/.test(read("prisma/schema.prisma")));
}

// ── pure blocker fn ──────────────────────────────────────────────────────
function blockerUnitTests() {
  console.log("\n── offerPublishBlockers ──");
  const base = { offerStatus: "DRAFT", sellerStatus: "APPROVED", marketplaceOpen: true, productStatus: "ACTIVE", variantStatus: "ACTIVE", available: 5 };
  ok("all gates pass → no blockers", offerPublishBlockers(base).length === 0);
  ok("seller not APPROVED → SELLER_NOT_APPROVED", offerPublishBlockers({ ...base, sellerStatus: "SUSPENDED" }).includes("SELLER_NOT_APPROVED"));
  ok("marketplace closed → MARKETPLACE_CLOSED", offerPublishBlockers({ ...base, marketplaceOpen: false }).includes("MARKETPLACE_CLOSED"));
  ok("product not ACTIVE → PRODUCT_NOT_ACTIVE", offerPublishBlockers({ ...base, productStatus: "DRAFT" }).includes("PRODUCT_NOT_ACTIVE"));
  ok("variant not ACTIVE → VARIANT_NOT_ACTIVE", offerPublishBlockers({ ...base, variantStatus: "ARCHIVED" }).includes("VARIANT_NOT_ACTIVE"));
  ok("available 0 → NO_STOCK", offerPublishBlockers({ ...base, available: 0 }).includes("NO_STOCK"));
  ok("archived offer → ARCHIVED", offerPublishBlockers({ ...base, offerStatus: "ARCHIVED" }).includes("ARCHIVED"));
  ok("multiple failures → multiple blockers", offerPublishBlockers({ ...base, productStatus: "DRAFT", available: 0 }).length === 2);
  ok("MARKETPLACE_CLOSED message unchanged from the pre-9F-24A gate",
    OFFER_PUBLISH_BLOCKER_MESSAGE.MARKETPLACE_CLOSED === "Offers can’t be published yet — the marketplace isn’t open to buyers.");
}

// ── DB behaviour (rolled-back fixtures) ──────────────────────────────────
async function dbTests() {
  console.log("\n── setSellerOfferStatus → ACTIVE (fixtures rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) return ok("(skipped — no category)", true);
  const sfx = "9f24a-" + Date.now();

  async function seed(
    tx: Prisma.TransactionClient,
    o: { sellerStatus?: string; productStatus?: string; variantStatus?: string; qty?: number; offerStatus?: string },
  ) {
    const seller = await tx.seller.create({
      data: { type: "THIRD_PARTY", status: o.sellerStatus ?? "APPROVED", displayName: `T ${sfx}`, slug: `t-${sfx}-${Math.random().toString(36).slice(2, 7)}`, supportEmail: "t@t.test" },
      select: { id: true },
    });
    const product = await tx.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: o.productStatus ?? "ACTIVE", price: 1000 },
      select: { id: true },
    });
    const variant = await tx.variant.create({
      data: { productId: product.id, sku: `v-${sfx}-${Math.random().toString(36).slice(2, 7)}`, price: 1000, status: o.variantStatus ?? "ACTIVE", stock: 0 },
      select: { id: true },
    });
    const offer = await tx.offer.create({
      data: { sellerId: seller.id, variantId: variant.id, price: 1000, condition: "NEW", status: o.offerStatus ?? "DRAFT", sellerSku: `os-${sfx}-${Math.random().toString(36).slice(2, 7)}` },
      select: { id: true },
    });
    await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: null, quantity: o.qty ?? 10, reserved: 0, reorderPoint: 3 } });
    return { sellerId: seller.id, offerId: offer.id };
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1 — DRAFT → ACTIVE, all gates pass
      {
        const f = await seed(tx, {});
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("1 · DRAFT → ACTIVE succeeds when all gates pass", r.ok && "storefrontAffected" in r && r.storefrontAffected === true && row.status === "ACTIVE");
      }
      // 2 — INACTIVE → ACTIVE, all gates pass
      {
        const f = await seed(tx, { offerStatus: "INACTIVE" });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("2 · INACTIVE → ACTIVE succeeds when all gates pass", r.ok && row.status === "ACTIVE");
      }
      // 3 — ACTIVE → INACTIVE
      {
        const f = await seed(tx, { offerStatus: "ACTIVE" });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "INACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("3 · ACTIVE → INACTIVE succeeds (storefrontAffected)", r.ok && "storefrontAffected" in r && r.storefrontAffected === true && row.status === "INACTIVE");
      }
      // 4 — seller not APPROVED
      {
        const f = await seed(tx, { sellerStatus: "SUSPENDED" });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("4 · → ACTIVE fails when seller is not APPROVED, offer unchanged",
          !r.ok && "error" in r && r.error.includes("isn’t approved") && row.status === "DRAFT");
      }
      // 6 — product not ACTIVE
      {
        const f = await seed(tx, { productStatus: "DRAFT" });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("6 · → ACTIVE fails when product is not ACTIVE, offer unchanged",
          !r.ok && "error" in r && /product live in the catalog/.test(r.error) && row.status === "DRAFT");
      }
      // 7 — variant not ACTIVE
      {
        const f = await seed(tx, { variantStatus: "ARCHIVED" });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("7 · → ACTIVE fails when variant is not ACTIVE, offer unchanged",
          !r.ok && "error" in r && /product option isn’t active/.test(r.error) && row.status === "DRAFT");
      }
      // 8 — no stock
      {
        const f = await seed(tx, { qty: 0 });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("8 · → ACTIVE fails when available inventory is 0, offer unchanged",
          !r.ok && "error" in r && /Add stock first/.test(r.error) && row.status === "DRAFT");
      }
      // 8b — reserved eats all stock
      {
        const f = await seed(tx, { qty: 3 });
        await tx.offerInventory.updateMany({ where: { offerId: f.offerId }, data: { reserved: 3 } });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        ok("8b · → ACTIVE fails when quantity − reserved = 0", !r.ok && "error" in r && /Add stock first/.test(r.error));
      }
      // 9 — ARCHIVED cannot be reactivated
      {
        const f = await seed(tx, { offerStatus: "ARCHIVED" });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        const row = await tx.offer.findUniqueOrThrow({ where: { id: f.offerId }, select: { status: true } });
        ok("9 · ARCHIVED → ACTIVE rejected, offer stays ARCHIVED",
          !r.ok && "error" in r && /archived offer can't be reactivated/.test(r.error) && row.status === "ARCHIVED");
      }
      // 5-ish — combined blockers surface all reasons
      {
        const f = await seed(tx, { productStatus: "DRAFT", qty: 0 });
        const r = await setSellerOfferStatus(ctxFor(f.sellerId), f.offerId, "ACTIVE", tx);
        ok("5 · combined failures → error names every blocking reason",
          !r.ok && "error" in r && /product live in the catalog/.test(r.error) && /Add stock first/.test(r.error));
      }
      // scoping — another seller's offer is invisible
      {
        const f = await seed(tx, {});
        const other = await seed(tx, {});
        const r = await setSellerOfferStatus(ctxFor(other.sellerId), f.offerId, "ACTIVE", tx);
        ok("scope · a seller can't publish another seller's offer (NOT_FOUND)", !r.ok && "code" in r && r.code === "NOT_FOUND");
      }

      throw new Rollback();
    }, { timeout: 90000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture offer leaked", (await prisma.offer.count({ where: { sellerSku: { contains: sfx } } })) === 0);
}

// ── production read-only ─────────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const sa = await prisma.offer.findFirst({
    where: { seller: { is: { displayName: "Style Avenue" } } },
    select: { id: true, status: true, condition: true, seller: { select: { status: true } }, inventory: { select: { quantity: true, reserved: true } } },
  });
  // qty is dynamic — it was 21, now 23 after the sanctioned 9F-33B cancellation of
  // AX-260907-100358 restored 2 units. This phase must not TOUCH the offer, so
  // assert its config fields, not an exact quantity snapshot.
  ok("prod · Style Avenue offer untouched by this phase — ACTIVE / NEW / seller APPROVED",
    sa?.status === "ACTIVE" && sa?.condition === "NEW" && sa?.seller.status === "APPROVED" && (sa?.inventory?.quantity ?? -1) >= 0,
    JSON.stringify(sa));
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("prod · marketplace.multiSellerCheckout still 'true' (not modified)", g?.value === "true");
  const tpActive = await prisma.offer.count({ where: { seller: { is: { type: "THIRD_PARTY" } }, status: "ACTIVE" } });
  ok("prod · exactly one ACTIVE THIRD_PARTY offer system-wide (unchanged)", tpActive === 1, String(tpActive));
  ok("prod · no leaked 9f24a fixtures", (await prisma.seller.count({ where: { slug: { contains: "9f24a" } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-24A — 3P offer activation\n");
  staticTests();
  blockerUnitTests();
  await dbTests();
  await prodTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
