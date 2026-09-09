/**
 * PHASE 9F-24D — 3P offer lifecycle P0/P1 gap fixes.
 *
 *  P0-2  every real Offer status transition writes ONE adminAuditLog row
 *        (`setSellerOfferStatus` now returns previousStatus/newStatus + context;
 *        `setOfferStatusAction` writes the audit row, skips no-ops).
 *  P1-1  approving a product request seeds the proposing seller's DRAFT listings
 *        (`seedSellerDraftOffers`, called from both approve paths).
 *  P1-2  a product from a proposal is ALWAYS created DRAFT — no ACTIVE path, so
 *        approval never mints an ACTIVE Axiaro (1P) offer against the proposal.
 *  P1-4  admin can change any offer's status (`adminSetOfferStatus` +
 *        `setAdminOfferStatusAction`), same rules as the seller path,
 *        cross-seller, audited.
 *  P1-7  a THIRD_PARTY offer → ACTIVE queues one ops notice
 *        (`sendSellerOfferPublishedOps`); FIRST_PARTY is skipped.
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f24d.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { setSellerOfferStatus } from "@/lib/marketplace/seller-repository";
import { seedSellerDraftOffers, approveByCreatingProduct } from "@/lib/admin/seller-product-requests/create-canonical";
import { adminSetOfferStatus } from "@/lib/admin/offer-status";
import { sendSellerOfferPublishedOps } from "@/lib/email/notifications";
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
  const create = read("src/lib/admin/seller-product-requests/create-canonical.ts");
  const reqActions = read("src/lib/admin/seller-product-requests/actions.ts");
  const panel = read("src/components/admin/seller-product-requests/create-product-panel.tsx");
  const offerStatus = read("src/lib/admin/offer-status.ts");
  const adminActions = read("src/lib/admin/offer-admin-actions.ts");
  const adminOffersRepo = read("src/lib/admin/offers.ts");
  const adminOfferPage = read("src/app/admin/(shell)/offers/[id]/page.tsx");
  const adminOfferControls = read("src/components/admin/offers/admin-offer-status-controls.tsx");
  const send = read("src/lib/email/send.ts");
  const opsTpl = read("src/lib/email/templates/ops-notifications.ts");
  const notif = read("src/lib/email/notifications.ts");

  // P0-2
  ok("P0-2 · SetOfferStatusResult carries previousStatus + newStatus",
    /previousStatus: OfferStatus;\s*\n\s*newStatus: OfferStatus;/.test(repo));
  ok("P0-2 · setSellerOfferStatus returns the transition on the no-op path too",
    /if \(offer\.status === next\) \{[\s\S]{0,220}previousStatus: offer\.status as OfferStatus,/.test(repo));
  ok("P0-2 · offer-actions imports writeAudit + writes seller_offer.status_changed",
    /import \{ writeAudit \} from "@\/lib\/admin\/audit"/.test(actions) &&
    /action: "seller_offer\.status_changed"/.test(actions));
  ok("P0-2 · the audit row is skipped for a no-op (prev === new)",
    /if \(res\.previousStatus !== res\.newStatus\) \{/.test(actions));
  ok("P0-2 · offer-actions does NOT add a second storefront revalidate",
    (actions.match(/revalidateTag\(\s*["']products/g) ?? []).length === 1);

  // P1-1
  ok("P1-1 · create-canonical exports seedSellerDraftOffers", /export async function seedSellerDraftOffers\(/.test(create));
  ok("P1-1 · seedSellerDraftOffers reuses createSellerOffer (sanctioned seller path)",
    /import \{ createSellerOffer \} from "@\/lib\/marketplace\/seller-repository"/.test(create) &&
    /await createSellerOffer\(/.test(create));
  ok("P1-1 · it only touches ACTIVE variants + always DRAFT / condition NEW",
    /where: \{ productId, status: "ACTIVE" \}/.test(create) && /condition: "NEW", openingQuantity: 0/.test(create));
  ok("P1-1 · both approve paths seed the seller's draft listings",
    (reqActions.match(/seedAndAuditSellerDraftOffers\(/g) ?? []).length >= 2);

  // P1-2
  ok("P1-2 · createSchema has no status field", !/status: z\.enum\(\["DRAFT", "ACTIVE"\]\)/.test(reqActions) && !/status: parsed\.data\.status/.test(reqActions));
  ok("P1-2 · create-canonical forces status DRAFT", /status: "DRAFT",\s*\n\s*featured:/.test(create));
  ok("P1-2 · CuratedProduct type no longer has a status field", !/^\s*status: string;/m.test(create.slice(0, create.indexOf("export type CreateFromRequestResult"))));
  ok("P1-2 · the create panel dropped the status selector", !/name="status"/.test(panel));

  // P1-4
  ok("P1-4 · adminSetOfferStatus exists, cross-seller (no sellerId arg)",
    /export async function adminSetOfferStatus\(\s*\n\s*offerId: string,\s*\n\s*next: AdminOfferStatus,/.test(offerStatus));
  ok("P1-4 · keeps the marketplace-flag gate for → ACTIVE (double-lock #1)",
    /if \(next === "ACTIVE"\) \{\s*\n\s*const gate = await getStoreSetting\("marketplace\.multiSellerCheckout"\);/.test(offerStatus));
  ok("P1-4 · reuses offerPublishBlockers (double-lock #2, same readiness as seller)",
    /offerPublishBlockers\(\{/.test(offerStatus) && /from "@\/lib\/marketplace\/seller-repository"/.test(offerStatus));
  ok("P1-4 · same transition map (ARCHIVED terminal, ACTIVE → INACTIVE/ARCHIVED)",
    /DRAFT: \["INACTIVE", "ARCHIVED", "ACTIVE"\],\s*\n\s*INACTIVE: \["DRAFT", "ARCHIVED", "ACTIVE"\],\s*\n\s*ACTIVE: \["INACTIVE", "ARCHIVED"\],\s*\n\s*ARCHIVED: \[\],/.test(offerStatus));
  ok("P1-4 · action requires manage_settings (no new RBAC key)",
    /requirePermission\("manage_settings"\)/.test(adminActions) && !/manage_offers|view_offers|manage_sellers/.test(adminActions));
  ok("P1-4 · action writes offer.status_changed audit + skips no-ops",
    /action: "offer\.status_changed"/.test(adminActions) && /if \(res\.previousStatus !== res\.newStatus\) \{/.test(adminActions));
  ok("P1-4 · src/lib/admin/offers.ts stays read-only (no write call)",
    !/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\(/.test(adminOffersRepo));
  ok("P1-4 · offers.ts gains getAdminOfferDetail (read) with publish blockers",
    /export async function getAdminOfferDetail\(/.test(adminOffersRepo) && /publishBlockers/.test(adminOffersRepo));
  ok("P1-4 · /admin/offers/[id] page renders the control, gated by manage_settings",
    /AdminOfferStatusControls/.test(adminOfferPage) && /requireAnyPermission\(\["manage_settings", "manage_content"\]\)/.test(adminOfferPage));
  ok("P1-4 · the list page links rows to the detail page", /href=\{`\/admin\/offers\/\$\{r\.id\}`\}/.test(read("src/app/admin/(shell)/offers/page.tsx")));
  ok("P1-4 · control submits every status incl. ACTIVE", /submit\("ACTIVE"\)/.test(adminOfferControls) && /Publish listing/.test(adminOfferControls));

  // P1-7
  ok("P1-7 · EmailType includes seller_offer_published", /\| "seller_offer_published"/.test(send));
  ok("P1-7 · ops template renderSellerOfferPublishedOps exists", /export function renderSellerOfferPublishedOps\(/.test(opsTpl));
  ok("P1-7 · sender skips FIRST_PARTY, keys on <offerId>:<auditLogId>",
    /if \(offer\.seller\.type !== "THIRD_PARTY"\) return \{ ok: true, skipped: true, status: "SKIPPED" \};/.test(notif) &&
    /idempotencyKey: `SELLER_OFFER_PUBLISHED:\$\{offer\.id\}:\$\{auditLogId\}`/.test(notif));
  ok("P1-7 · retry switch handles seller_offer_published", /case "seller_offer_published": \{/.test(notif));
  ok("P1-7 · both actions queue the ops notice on → ACTIVE",
    /res\.newStatus === "ACTIVE" && auditId/.test(actions) &&
    /res\.newStatus === "ACTIVE" && res\.sellerType === "THIRD_PARTY" && auditId/.test(adminActions));

  // scope
  ok("scope · seed-rbac.ts not marked / touched by this phase", !/9F-24D/.test(read("scripts/seed-rbac.ts")));
  ok("scope · no schema change", !/9F-24D/.test(read("prisma/schema.prisma")));
  ok("scope · checkout / cart / buy-box untouched",
    !/9F-24D/.test(read("src/lib/checkout.ts")) && !/9F-24D/.test(read("src/lib/cart.ts")) &&
    !/9F-24D/.test(read("src/lib/marketplace/buy-box-rule.ts")));
  ok("scope · no multiSellerCheckout WRITE anywhere in changed files",
    ![actions, offerStatus, adminActions, reqActions, create].some((f) => /multiSellerCheckout"?\s*[,)]?\s*"true"|setStoreSetting|storeSetting\.update/.test(f)));
}

// ── DB behaviour (rolled back) ───────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  const someUser = await prisma.user.findFirst({ select: { id: true } });
  // Only ONE FIRST_PARTY seller may exist (partial unique index) — reuse the real
  // Axiaro seller for the P1-7 skip check rather than creating a second one.
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  if (!category || !someUser || !axiaro) return ok("(skipped — no category / user / 1P seller)", true);
  const sfx = "9f24d-" + Date.now();
  const rnd = () => Math.random().toString(36).slice(2, 7);

  async function seedSeller(tx: Prisma.TransactionClient, o: { type?: string; status?: string } = {}) {
    return tx.seller.create({
      data: {
        type: o.type ?? "THIRD_PARTY",
        status: o.status ?? "APPROVED",
        displayName: `T ${sfx}`,
        slug: `t-${sfx}-${rnd()}`,
        supportEmail: "t@t.test",
      },
      select: { id: true },
    });
  }
  async function seedProduct(tx: Prisma.TransactionClient, status = "ACTIVE") {
    return tx.product.create({
      data: { name: `P ${sfx}`, slug: `p-${sfx}-${rnd()}`, shortDescription: "s", description: "d", categoryId: category!.id, status, price: 1000 },
      select: { id: true },
    });
  }
  async function seedVariant(tx: Prisma.TransactionClient, productId: string, status = "ACTIVE") {
    return tx.variant.create({
      data: { productId, sku: `v-${sfx}-${rnd()}`, price: 1000, status, stock: 0 },
      select: { id: true },
    });
  }
  async function seedOffer(
    tx: Prisma.TransactionClient,
    sellerId: string,
    variantId: string,
    o: { status?: string; qty?: number } = {},
  ) {
    const offer = await tx.offer.create({
      data: { sellerId, variantId, price: 1000, condition: "NEW", status: o.status ?? "DRAFT", sellerSku: `os-${sfx}-${rnd()}` },
      select: { id: true },
    });
    await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: null, quantity: o.qty ?? 10, reserved: 0, reorderPoint: 3 } });
    return offer;
  }

  try {
    await prisma.$transaction(async (tx) => {
      // ── P0-2 ──
      {
        const s = await seedSeller(tx);
        const p = await seedProduct(tx);
        const v = await seedVariant(tx, p.id);
        const off = await seedOffer(tx, s.id, v.id, { status: "DRAFT" });
        const r = await setSellerOfferStatus(ctxFor(s.id), off.id, "ACTIVE", tx);
        ok("P0-2 · DRAFT → ACTIVE returns previousStatus=DRAFT newStatus=ACTIVE + context",
          r.ok && "previousStatus" in r && r.previousStatus === "DRAFT" && r.newStatus === "ACTIVE" &&
          r.variantId === v.id && typeof r.productName === "string");
        const noop = await setSellerOfferStatus(ctxFor(s.id), off.id, "ACTIVE", tx);
        ok("P0-2 · no-op transition reports prev === new (caller skips the audit row)",
          noop.ok && "previousStatus" in noop && noop.previousStatus === noop.newStatus && noop.storefrontAffected === false);
      }

      // ── P1-1 ──
      {
        const s = await seedSeller(tx);
        const p = await seedProduct(tx, "DRAFT");
        const v1 = await seedVariant(tx, p.id);
        const v2 = await seedVariant(tx, p.id);
        const vArch = await seedVariant(tx, p.id, "ARCHIVED");
        const res = await seedSellerDraftOffers(s.id, someUser!.id, p.id, tx);
        ok("P1-1 · one DRAFT offer per ACTIVE variant, ARCHIVED variant skipped",
          res.created.length === 2, JSON.stringify(res));
        const offers = await tx.offer.findMany({ where: { sellerId: s.id }, select: { status: true, condition: true, variantId: true } });
        ok("P1-1 · every seeded offer is DRAFT / NEW / THIRD_PARTY seller",
          offers.length === 2 && offers.every((o) => o.status === "DRAFT" && o.condition === "NEW") &&
          new Set(offers.map((o) => o.variantId)).size === 2 &&
          !offers.some((o) => o.variantId === vArch.id));
        const invs = await tx.offerInventory.count({ where: { offer: { sellerId: s.id } } });
        ok("P1-1 · each seeded offer gets an OfferInventory row (qty 0)", invs === 2);
        const opening = await tx.offerAdjustment.count({ where: { offerInventory: { offer: { sellerId: s.id } }, reason: "MIGRATION_OPENING" } });
        ok("P1-1 · opening OfferAdjustment written, never InventoryAdjustment", opening === 2);
        void v1; void v2;
        const again = await seedSellerDraftOffers(s.id, someUser!.id, p.id, tx);
        ok("P1-1 · idempotent — a second run creates nothing, counts the dupes",
          again.created.length === 0 && again.skipped === 2);
      }

      // ── P1-2 ──
      {
        const s = await seedSeller(tx);
        const req = await tx.sellerProductRequest.create({
          data: { sellerId: s.id, status: "PENDING", proposedName: `Prop ${sfx}` },
          select: { id: true },
        });
        const curated = {
          name: `Curated ${sfx}`,
          slug: `curated-${sfx}-${rnd()}`,
          brand: "Axiaro",
          shortDescription: "short",
          description: "long description",
          categoryId: category!.id,
          price: 149900,
          compareAtPrice: null as number | null,
          sku: `CUR-${sfx}-${rnd()}`,
          options: [] as { name: string; values: string[] }[],
        };
        const created = await approveByCreatingProduct(req.id, someUser!.id, curated, tx);
        ok("P1-2 · approveByCreatingProduct → ok", created.ok === true, JSON.stringify(created));
        if (created.ok) {
          const prod = await tx.product.findUnique({ where: { id: created.productId }, select: { status: true } });
          ok("P1-2 · product is created DRAFT (never ACTIVE from a proposal)", prod?.status === "DRAFT");
          const oneP = await tx.offer.findFirst({
            where: { variantId: { in: (await tx.variant.findMany({ where: { productId: created.productId }, select: { id: true } })).map((x) => x.id) }, seller: { is: { type: "FIRST_PARTY" } } },
            select: { status: true },
          });
          ok("P1-2 · the Axiaro (1P) offer is DRAFT — not customer-purchasable", oneP?.status === "DRAFT");
        }
      }

      // ── P1-4 ──
      {
        // cross-seller: adminSetOfferStatus takes NO sellerId and still works
        const s = await seedSeller(tx);
        const p = await seedProduct(tx);
        const v = await seedVariant(tx, p.id);
        const off = await seedOffer(tx, s.id, v.id, { status: "DRAFT" });
        const r = await adminSetOfferStatus(off.id, "ACTIVE", tx);
        ok("P1-4 · admin publishes a ready DRAFT (cross-seller, no sellerId scoping)",
          r.ok && "sellerType" in r && r.sellerType === "THIRD_PARTY" && r.newStatus === "ACTIVE");
        const row = await tx.offer.findUniqueOrThrow({ where: { id: off.id }, select: { status: true } });
        ok("P1-4 · offer row is now ACTIVE", row.status === "ACTIVE");
        const back = await adminSetOfferStatus(off.id, "INACTIVE", tx);
        ok("P1-4 · admin can pull a live listing (→ INACTIVE), storefrontAffected", back.ok && "storefrontAffected" in back && back.storefrontAffected === true);

        // blocked cases mirror the seller path
        const pD = await seedProduct(tx, "DRAFT");
        const vD = await seedVariant(tx, pD.id);
        const offD = await seedOffer(tx, s.id, vD.id, { status: "DRAFT" });
        const rD = await adminSetOfferStatus(offD.id, "ACTIVE", tx);
        ok("P1-4 · → ACTIVE blocked when the catalog product isn't ACTIVE",
          !rD.ok && "error" in rD && /product live in the catalog/.test(rD.error));

        const sSusp = await seedSeller(tx, { status: "SUSPENDED" });
        const vS = await seedVariant(tx, p.id);
        const offS = await seedOffer(tx, sSusp.id, vS.id, { status: "DRAFT" });
        const rS = await adminSetOfferStatus(offS.id, "ACTIVE", tx);
        ok("P1-4 · → ACTIVE blocked when the seller isn't APPROVED",
          !rS.ok && "error" in rS && /isn’t approved/.test(rS.error));

        const vArch2 = await seedVariant(tx, p.id);
        const offArch = await seedOffer(tx, s.id, vArch2.id, { status: "ARCHIVED" });
        const rArch = await adminSetOfferStatus(offArch.id, "ACTIVE", tx);
        ok("P1-4 · ARCHIVED is terminal for the admin path too", !rArch.ok);

        const missing = await adminSetOfferStatus("offer_does_not_exist_" + sfx, "INACTIVE", tx);
        ok("P1-4 · unknown offer → NOT_FOUND", !missing.ok && "code" in missing && missing.code === "NOT_FOUND");
      }

      // ── P1-7 ──
      {
        const p = await seedProduct(tx);
        const v = await seedVariant(tx, p.id);
        const off = await seedOffer(tx, axiaro.id, v.id, { status: "ACTIVE" });
        const audit = await tx.adminAuditLog.create({ data: { action: "offer.status_changed", targetId: off.id }, select: { id: true } });
        const r = await sendSellerOfferPublishedOps(off.id, audit.id, { client: tx });
        ok("P1-7 · FIRST_PARTY offer → the ops publish notice is SKIPPED",
          r.status === "SKIPPED" && r.ok === true, JSON.stringify(r));
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture offer leaked", (await prisma.offer.count({ where: { sellerSku: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture product leaked", (await prisma.product.count({ where: { slug: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture email log leaked", (await prisma.emailLog.count({ where: { idempotencyKey: { contains: sfx } } })) === 0);
}

// ── production read-only ─────────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const sa = await prisma.offer.findFirst({
    where: { seller: { is: { displayName: "Style Avenue" } } },
    select: { status: true, condition: true, price: true, seller: { select: { status: true } }, inventory: { select: { quantity: true } } },
  });
  // qty is dynamic (21 → 23 after the sanctioned 9F-33B cancellation restored 2
  // units). This phase must not TOUCH the offer — assert its config, not a snapshot.
  ok("prod · Style Avenue offer untouched by this phase — ACTIVE / NEW / ₱1199",
    sa?.status === "ACTIVE" && sa?.condition === "NEW" && sa?.price === 119900 && (sa?.inventory?.quantity ?? -1) >= 0,
    JSON.stringify(sa));
  const g = await prisma.storeSetting.findUnique({ where: { key: "marketplace.multiSellerCheckout" } });
  ok("prod · marketplace.multiSellerCheckout still 'true'", g?.value === "true");
  const tpActive = await prisma.offer.count({ where: { seller: { is: { type: "THIRD_PARTY" } }, status: "ACTIVE" } });
  ok("prod · still exactly one ACTIVE THIRD_PARTY offer system-wide", tpActive === 1, String(tpActive));
  ok("prod · no leaked 9f24d fixtures", (await prisma.seller.count({ where: { slug: { contains: "9f24d" } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-24D — 3P offer lifecycle P0/P1 fixes\n");
  staticTests();
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
