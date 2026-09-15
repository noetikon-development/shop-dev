/**
 * Seller Verification — offer creation/activation gate (Phase 6).
 *
 * Business policy under test: a THIRD_PARTY seller's LATEST SellerVerification
 * row must be APPROVED before they can (a) create a new offer, or (b) publish
 * (→ ACTIVE) an offer. FIRST_PARTY sellers are exempt. Every other seller
 * capability (Settings, Verification itself, Dashboard, Orders/Returns/
 * Settlements view, order acceptance, shipment saving, return receipt,
 * cancellation) is explicitly OUT of scope for this phase and must stay
 * ungated.
 *
 * Two of the gate's three real enforcement points are plain, request-free
 * functions and are driven DIRECTLY:
 *   - `sellerVerificationSatisfiesGate` (src/lib/marketplace/seller-permissions.ts)
 *     — the pure decision behind `requireVerifiedSellerSession`
 *     (src/lib/seller/session.ts), deliberately kept in a framework-free
 *     module (unlike session.ts / seller-context.ts, which pull in real
 *     `next/navigation` / `next/headers` and crash outside a live request —
 *     the reason every prior phase's tests only ever exercise those two
 *     modules via static source checks, never a direct import).
 *   - `offerPublishBlockers` (src/lib/marketplace/seller-repository.ts) — the
 *     pure blocker list `setSellerOfferStatus` evaluates inside its own
 *     transaction.
 * The third, `resolveSellerVerificationGateStatus`, is a plain async Prisma
 * read (no live request needed either) and is exercised against real,
 * ROLLED-BACK fixtures — no Supabase Storage I/O is needed anywhere in this
 * phase (no document upload), so unlike Phases 3-5, every DB fixture here is
 * inside one `$transaction` + `throw new Rollback()`, never committed.
 *
 * `createOfferAction`'s own gate (`requireVerifiedSellerSession`) is confirmed
 * by (1) the pure-function tests above proving the DECISION is correct, and
 * (2) a static check that the action actually calls it — the same two-part
 * pattern every prior phase's test file uses for a seller-portal action.
 * `createSellerOffer` (the repository function) is DELIBERATELY not gated
 * itself — it is shared with the admin plane's `seedSellerDraftOffers`
 * synthetic-context seeding path, which must keep working (seeded offers stay
 * DRAFT and are still subject to the real activation gate).
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-seller-verification-p6.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  offerPublishBlockers,
  createSellerOffer,
  setSellerOfferStatus,
} from "../src/lib/marketplace/seller-repository";
import { resolveSellerVerificationGateStatus } from "../src/lib/seller-verification/repository";
import { sellerVerificationSatisfiesGate } from "../src/lib/marketplace/seller-permissions";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient();
class Rollback extends Error {}

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function ctxFor(sellerId: string, extra: Partial<SellerContext> = {}): SellerContext {
  return {
    sellerId,
    sellerName: "P6V",
    sellerUserId: "p6v-su",
    userId: "p6v-user",
    role: "OWNER",
    permissions: new Set(["manage_offers", "manage_offer_inventory"]),
    ...extra,
  };
}

const BASE_BLOCKER_INPUT = {
  offerStatus: "DRAFT",
  sellerStatus: "APPROVED",
  marketplaceOpen: true,
  productStatus: "ACTIVE",
  variantStatus: "ACTIVE",
  available: 5,
};

async function main() {
  console.log("\nSeller Verification — offer creation/activation gate (Phase 6)\n");

  // ── static — wiring, and scope discipline ("do not gate" list) ─────────
  const offerActionsSrc = read("src/lib/seller/offer-actions.ts");
  const sellerRepoSrc = read("src/lib/marketplace/seller-repository.ts");
  const sessionSrc = read("src/lib/seller/session.ts");
  const sellerContextSrc = read("src/lib/marketplace/seller-context.ts");
  const layoutSrc = read("src/app/seller/(portal)/layout.tsx");
  const settingsActionsSrc = read("src/lib/seller/settings-actions.ts");
  const verificationActionsSrc = read("src/lib/seller-verification/actions.ts");
  const orderActionsSrc = read("src/lib/seller/order-actions.ts");
  const returnActionsSrc = read("src/lib/seller/return-actions.ts");
  const productRequestActionsSrc = read("src/lib/seller/product-request-actions.ts");
  const seedRbacSrc = read("scripts/seed-rbac.ts");

  ok("· createOfferAction calls requireVerifiedSellerSession (not the plain permission check)",
    (() => {
      const m = offerActionsSrc.match(/export async function createOfferAction[\s\S]*?\r?\n\}/);
      return !!m && /requireVerifiedSellerSession\("manage_offers"\)/.test(m[0]);
    })());
  ok("· updateOfferAction / adjustOfferStockAction / setOfferReorderPointAction are UNCHANGED (still the plain permission check, not gated by verification)",
    (() => {
      const u = offerActionsSrc.match(/export async function updateOfferAction[\s\S]*?\r?\n\}/);
      const a = offerActionsSrc.match(/export async function adjustOfferStockAction[\s\S]*?\r?\n\}/);
      const r = offerActionsSrc.match(/export async function setOfferReorderPointAction[\s\S]*?\r?\n\}/);
      return !!u && !!a && !!r &&
        /requireSellerSessionPermission\("manage_offers"\)/.test(u[0]) &&
        /requireSellerSessionPermission\("manage_offer_inventory"\)/.test(a[0]) &&
        /requireSellerSessionPermission\("manage_offer_inventory"\)/.test(r[0]) &&
        !/requireVerifiedSellerSession/.test(u[0]) && !/requireVerifiedSellerSession/.test(a[0]) && !/requireVerifiedSellerSession/.test(r[0]);
    })());
  ok("D · setOfferStatusAction itself is UNCHANGED (still the plain permission check) — the verification gate lives inside setSellerOfferStatus/offerPublishBlockers, not the action, so DRAFT↔INACTIVE/ARCHIVED transitions stay ungated",
    (() => {
      const m = offerActionsSrc.match(/export async function setOfferStatusAction[\s\S]*?\r?\n\}/);
      return !!m && /requireSellerSessionPermission\("manage_offers"\)/.test(m[0]) && !/requireVerifiedSellerSession/.test(m[0]);
    })());
  ok("D · offerPublishBlockers includes the SELLER_NOT_VERIFIED blocker, beside SELLER_NOT_APPROVED",
    /SELLER_NOT_VERIFIED/.test(sellerRepoSrc) && /SELLER_NOT_APPROVED/.test(sellerRepoSrc));
  ok("· setSellerOfferStatus resolves verification status FRESH inside its own transaction (not trusting a possibly-stale ctx field)",
    (() => {
      const m = sellerRepoSrc.match(/export async function setSellerOfferStatus[\s\S]*?\n(?=export |\/\/ -{3})/);
      return !!m && /resolveSellerVerificationGateStatus\(\s*\{\s*id:\s*ctx\.sellerId,\s*type:\s*offer\.seller\.type\s*\},?\s*tx,?\s*\)/.test(m[0]);
    })());
  ok("C · createSellerOffer itself does NOT check verification (intentionally shared with admin's seedSellerDraftOffers seeding path)",
    (() => {
      const m = sellerRepoSrc.match(/export async function createSellerOffer[\s\S]*?\n(?=export )/);
      return !!m && !/verificationStatus|resolveSellerVerificationGateStatus/.test(m[0]);
    })());

  ok("A · SellerContext.verificationStatus is resolved centrally in getCurrentSellerContext()",
    /verificationStatus\s*=\s*await resolveSellerVerificationGateStatus\(seller\)/.test(sellerContextSrc));
  ok("· getCurrentSellerContext's own pass/fail logic is unaffected — no verification check gates the context itself",
    (() => {
      const m = sellerContextSrc.match(/export const getCurrentSellerContext[\s\S]*?\n\);/);
      return !!m && !/if \([^)]*verificationStatus[^)]*\)\s*(return null|forbidden)/.test(m[0]);
    })());
  ok("IMPORTANT · the portal layout does NOT call requireVerifiedSellerSession (not a global gate)",
    !/requireVerifiedSellerSession/.test(layoutSrc));
  ok("E · Settings actions are NOT gated by verification",
    !/requireVerifiedSellerSession/.test(settingsActionsSrc));
  ok("E · Seller Verification's own actions are NOT gated by verification (must stay reachable pre-approval)",
    !/requireVerifiedSellerSession/.test(verificationActionsSrc));
  ok("E · order acceptance / shipment saving / cancellation are NOT gated by verification",
    !/requireVerifiedSellerSession/.test(orderActionsSrc));
  ok("E · return receipt is NOT gated by verification",
    !/requireVerifiedSellerSession/.test(returnActionsSrc));
  ok("scope · product-request actions are untouched by this phase (not broadened beyond offer creation/activation)",
    !/requireVerifiedSellerSession/.test(productRequestActionsSrc));
  ok("scope · scripts/seed-rbac.ts untouched by this phase",
    !/Phase 6|SELLER_NOT_VERIFIED|verificationStatus/.test(seedRbacSrc));
  ok("B · requireVerifiedSellerSession is built on requireSellerSessionPermission (auth + permission preserved)",
    /const session = await requireSellerSessionPermission\(permission\);/.test(sessionSrc) &&
    /export async function requireVerifiedSellerSession/.test(sessionSrc));
  ok("B · requireVerifiedSellerSession's decision comes from the shared, framework-free sellerVerificationSatisfiesGate (not a re-implemented inline check)",
    /import \{ sellerVerificationSatisfiesGate \} from "@\/lib\/marketplace\/seller-permissions"/.test(sessionSrc) &&
    /if \(sellerVerificationSatisfiesGate\(session\.ctx\.verificationStatus\)\)/.test(sessionSrc));

  // ── pure-function tests — sellerVerificationSatisfiesGate ────────────────
  console.log("\n── sellerVerificationSatisfiesGate (pure) ──");
  ok("EXEMPT → satisfied", sellerVerificationSatisfiesGate("EXEMPT") === true);
  ok("APPROVED → satisfied", sellerVerificationSatisfiesGate("APPROVED") === true);
  ok("NONE → NOT satisfied (fail closed)", sellerVerificationSatisfiesGate("NONE") === false);
  ok("DRAFT → NOT satisfied (fail closed)", sellerVerificationSatisfiesGate("DRAFT") === false);
  ok("PENDING → NOT satisfied (fail closed)", sellerVerificationSatisfiesGate("PENDING") === false);
  ok("REJECTED → NOT satisfied (fail closed)", sellerVerificationSatisfiesGate("REJECTED") === false);
  ok("undefined → NOT satisfied (fail closed — a ctx that never resolved this field)", sellerVerificationSatisfiesGate(undefined) === false);

  // ── pure-function tests — offerPublishBlockers ───────────────────────────
  console.log("\n── offerPublishBlockers (pure) ──");
  for (const status of ["NONE", "DRAFT", "PENDING", "REJECTED"] as const) {
    ok(`THIRD_PARTY, verificationStatus=${status} → SELLER_NOT_VERIFIED blocks activation`,
      offerPublishBlockers({ ...BASE_BLOCKER_INPUT, verificationStatus: status }).includes("SELLER_NOT_VERIFIED"));
  }
  ok("5 · THIRD_PARTY, verificationStatus=APPROVED → no SELLER_NOT_VERIFIED blocker",
    !offerPublishBlockers({ ...BASE_BLOCKER_INPUT, verificationStatus: "APPROVED" }).includes("SELLER_NOT_VERIFIED"));
  ok("6 · FIRST_PARTY (verificationStatus=EXEMPT) → no SELLER_NOT_VERIFIED blocker, even with no row ever existing",
    !offerPublishBlockers({ ...BASE_BLOCKER_INPUT, verificationStatus: "EXEMPT" }).includes("SELLER_NOT_VERIFIED"));
  ok("· SELLER_NOT_APPROVED and SELLER_NOT_VERIFIED are independent — both can fire together",
    offerPublishBlockers({ ...BASE_BLOCKER_INPUT, sellerStatus: "SUSPENDED", verificationStatus: "PENDING" })
      .join(",") === ["SELLER_NOT_APPROVED", "SELLER_NOT_VERIFIED"].join(","));

  // ── DB tests — resolveSellerVerificationGateStatus + setSellerOfferStatus
  // (rolled back; no Supabase Storage I/O needed anywhere in this phase) ───
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) {
    ok("(skipped — no category to seed a fixture product against)", true);
  } else {
    const sfx = "p6v-" + Date.now().toString(36);
    try {
      await prisma.$transaction(async (tx) => {
        async function seedSeller(type: "FIRST_PARTY" | "THIRD_PARTY", tag: string) {
          return tx.seller.create({
            data: {
              type,
              status: "APPROVED",
              displayName: `P6 ${type} ${tag}`,
              slug: `${sfx}-${tag}-${Math.random().toString(36).slice(2, 7)}`,
              supportEmail: "p6v@t.test",
            },
            select: { id: true, type: true },
          });
        }
        async function seedOffer(sellerId: string, opts: { status?: string; qty?: number } = {}) {
          const product = await tx.product.create({
            data: {
              name: `P6 ${sfx}`,
              slug: `p6-${sfx}-${Math.random().toString(36).slice(2, 7)}`,
              shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000,
            },
            select: { id: true },
          });
          const variant = await tx.variant.create({
            data: { productId: product.id, sku: `v-${sfx}-${Math.random().toString(36).slice(2, 7)}`, price: 1000, status: "ACTIVE", stock: 0 },
            select: { id: true },
          });
          const offer = await tx.offer.create({
            data: { sellerId, variantId: variant.id, price: 1000, condition: "NEW", status: opts.status ?? "DRAFT", sellerSku: `os-${sfx}-${Math.random().toString(36).slice(2, 7)}` },
            select: { id: true },
          });
          await tx.offerInventory.create({ data: { offerId: offer.id, sellerSku: null, quantity: opts.qty ?? 10, reserved: 0, reorderPoint: 3 } });
          return offer.id;
        }
        async function seedVerification(sellerId: string, status: string, createdAt: Date) {
          return tx.sellerVerification.create({ data: { sellerId, status, createdAt }, select: { id: true } });
        }

        // ── resolveSellerVerificationGateStatus — categories 1-6 ───────────
        console.log("\n── resolveSellerVerificationGateStatus (rolled-back fixtures) ──");
        {
          // `Seller.type = "FIRST_PARTY"` is a real DB singleton (Axiaro holds
          // it — a partial unique index enforces exactly one). This function
          // short-circuits on `type === "FIRST_PARTY"` BEFORE ever querying,
          // so a fake, nonexistent sellerId proves "no row required" without
          // creating (or needing) a second FIRST_PARTY seller row.
          const status = await resolveSellerVerificationGateStatus({ id: "nonexistent-fp-seller", type: "FIRST_PARTY" }, tx);
          ok("6 · FIRST_PARTY with NO verification row (and no Seller row at all) → EXEMPT", status === "EXEMPT");
        }
        {
          const tp = await seedSeller("THIRD_PARTY", "tp-none");
          const status = await resolveSellerVerificationGateStatus(tp, tx);
          ok("1 · THIRD_PARTY with NO verification row → NONE", status === "NONE");
        }
        for (const s of ["DRAFT", "PENDING", "REJECTED", "APPROVED"] as const) {
          const tp = await seedSeller("THIRD_PARTY", `tp-${s.toLowerCase()}`);
          await seedVerification(tp.id, s, new Date());
          const status = await resolveSellerVerificationGateStatus(tp, tx);
          ok(`resolveSellerVerificationGateStatus reflects a single ${s} row → ${s}`, status === s);
        }

        // ── 7 — latest-row correctness (never "any approved row") ─────────
        console.log("\n── 7 · latest-row correctness ──");
        {
          const tp = await seedSeller("THIRD_PARTY", "tp-rej-then-draft");
          await seedVerification(tp.id, "REJECTED", new Date(Date.now() - 120_000));
          await seedVerification(tp.id, "DRAFT", new Date(Date.now() - 60_000));
          const status = await resolveSellerVerificationGateStatus(tp, tx);
          ok("7 · rows [REJECTED, DRAFT] (by createdAt) → resolves to the LATEST (DRAFT), not REJECTED", status === "DRAFT");
          const blocked = !offerPublishBlockers({ ...BASE_BLOCKER_INPUT, verificationStatus: status }).length ? false : true;
          ok("7 · [REJECTED, DRAFT] → activation blocked", blocked);
        }
        {
          const tp = await seedSeller("THIRD_PARTY", "tp-rej-then-approved");
          await seedVerification(tp.id, "REJECTED", new Date(Date.now() - 120_000));
          await seedVerification(tp.id, "APPROVED", new Date(Date.now() - 60_000));
          const status = await resolveSellerVerificationGateStatus(tp, tx);
          ok("7 · rows [REJECTED, APPROVED] (by createdAt) → resolves to the LATEST (APPROVED) — proves this is NOT an 'any row ever approved' check reading the wrong row by accident", status === "APPROVED");
          ok("7 · [REJECTED, APPROVED] → activation allowed",
            offerPublishBlockers({ ...BASE_BLOCKER_INPUT, verificationStatus: status }).length === 0);
        }

        // ── end-to-end via setSellerOfferStatus — categories 1-5 ───────────
        console.log("\n── setSellerOfferStatus → ACTIVE, end-to-end (rolled-back fixtures) ──");
        for (const s of ["NONE", "DRAFT", "PENDING", "REJECTED"] as const) {
          const tp = await seedSeller("THIRD_PARTY", `e2e-${s.toLowerCase()}`);
          if (s !== "NONE") await seedVerification(tp.id, s, new Date());
          const offerId = await seedOffer(tp.id);
          const r = await setSellerOfferStatus(ctxFor(tp.id), offerId, "ACTIVE", tx);
          const row = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } });
          ok(`${s === "NONE" ? "1" : s === "DRAFT" ? "2" : s === "PENDING" ? "3" : "4"} · THIRD_PARTY, verification=${s} → activate BLOCKED, offer stays DRAFT`,
            !r.ok && "error" in r && r.error.includes("Complete seller verification") && row.status === "DRAFT", JSON.stringify(r));
        }
        {
          const tp = await seedSeller("THIRD_PARTY", "e2e-approved");
          await seedVerification(tp.id, "APPROVED", new Date());
          const offerId = await seedOffer(tp.id);
          const r = await setSellerOfferStatus(ctxFor(tp.id), offerId, "ACTIVE", tx);
          const row = await tx.offer.findUniqueOrThrow({ where: { id: offerId }, select: { status: true } });
          ok("5 · THIRD_PARTY, verification=APPROVED → activate ALLOWED", r.ok === true && row.status === "ACTIVE", JSON.stringify(r));
        }

        // ── 6 — FIRST_PARTY create + activate, no verification row ever ────
        console.log("\n── 6 · FIRST_PARTY exemption, end-to-end ──");
        {
          // `Seller.type = "FIRST_PARTY"` is a real DB singleton — a partial
          // unique index enforces exactly one such row, and Axiaro already
          // holds it, so this phase's fixtures can never create a second one.
          // Using Axiaro's own real id for a TEMPORARY offer inside this same
          // rolled-back transaction (never committed, never touching any of
          // Axiaro's 332 real offers) is the only safe way to exercise the
          // FIRST_PARTY path end-to-end.
          const axiaro = await tx.seller.findFirstOrThrow({ where: { type: "FIRST_PARTY" }, select: { id: true } });
          const product = await tx.product.create({
            data: { name: `P6FP ${sfx}`, slug: `p6fp-${sfx}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 },
            select: { id: true },
          });
          const variant = await tx.variant.create({
            data: { productId: product.id, sku: `v-fp-${sfx}`, price: 1000, status: "ACTIVE", stock: 0 },
            select: { id: true },
          });
          const created = await createSellerOffer(ctxFor(axiaro.id), { variantId: variant.id, price: 1000, openingQuantity: 5, condition: "NEW" }, tx);
          ok("6 · FIRST_PARTY create offer → ALLOWED (createSellerOffer never checks verification)", created.ok === true, JSON.stringify(created));
          if (created.ok) {
            const r = await setSellerOfferStatus(ctxFor(axiaro.id), created.offerId, "ACTIVE", tx);
            ok("6 · FIRST_PARTY activate offer → ALLOWED with zero SellerVerification rows ever existing", r.ok === true, JSON.stringify(r));
          }
        }

        // ── 9 (existing behaviour) — save-draft / update / stock / reorder /
        // DRAFT↔INACTIVE/ARCHIVED transitions are untouched by this phase ───
        console.log("\n── 9 · existing behaviour unaffected ──");
        {
          const tp = await seedSeller("THIRD_PARTY", "existing-behaviour");
          // no verification row at all — NONE
          const offerId = await seedOffer(tp.id);
          const toInactive = await setSellerOfferStatus(ctxFor(tp.id), offerId, "INACTIVE", tx);
          ok("9 · DRAFT → INACTIVE still works for an UNVERIFIED seller (not an activation)", toInactive.ok === true, JSON.stringify(toInactive));
          const backToDraft = await setSellerOfferStatus(ctxFor(tp.id), offerId, "DRAFT", tx);
          ok("9 · INACTIVE → DRAFT still works for an UNVERIFIED seller", backToDraft.ok === true, JSON.stringify(backToDraft));
          const toArchived = await setSellerOfferStatus(ctxFor(tp.id), offerId, "ARCHIVED", tx);
          ok("9 · DRAFT → ARCHIVED still works for an UNVERIFIED seller", toArchived.ok === true, JSON.stringify(toArchived));
        }
        {
          // createSellerOffer / updateSellerOffer / adjustOfferStock remain callable
          // regardless of verification — only the →ACTIVE transition is gated.
          const tp = await seedSeller("THIRD_PARTY", "create-unaffected");
          const product = await tx.product.create({
            data: { name: `P6U ${sfx}`, slug: `p6u-${sfx}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 },
            select: { id: true },
          });
          const variant = await tx.variant.create({
            data: { productId: product.id, sku: `v-u-${sfx}`, price: 1000, status: "ACTIVE", stock: 0 },
            select: { id: true },
          });
          const created = await createSellerOffer(ctxFor(tp.id), { variantId: variant.id, price: 1000, openingQuantity: 5, condition: "NEW" }, tx);
          ok("9 · createSellerOffer (repository) succeeds for an unverified THIRD_PARTY seller — the gate is the ACTION layer's requireVerifiedSellerSession, not this function", created.ok === true, JSON.stringify(created));
        }

        // ── 8 — direct server-side bypass (activation) ─────────────────────
        console.log("\n── 8 · direct repository bypass (activation) ──");
        {
          const tp = await seedSeller("THIRD_PARTY", "bypass");
          await seedVerification(tp.id, "PENDING", new Date());
          const offerId = await seedOffer(tp.id);
          // Calling the repository function directly — no action, no UI, no form.
          const r = await setSellerOfferStatus(ctxFor(tp.id), offerId, "ACTIVE", tx);
          ok("8 · calling setSellerOfferStatus directly (bypassing any UI/action) still fails for an unverified THIRD_PARTY seller",
            !r.ok && "error" in r && r.error.includes("Complete seller verification"), JSON.stringify(r));
        }

        throw new Rollback();
      }, { timeout: 90000 });
    } catch (e) {
      if (!(e instanceof Rollback)) throw e;
    }
    ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
    ok("ROLLBACK · no fixture offer leaked", (await prisma.offer.count({ where: { sellerSku: { contains: sfx } } })) === 0);
    ok("ROLLBACK · no fixture product leaked", (await prisma.product.count({ where: { slug: { contains: sfx } } })) === 0);
  }

  // ── production (READ-ONLY) — Axiaro / Style Avenue / Sandbox Seller ─────
  console.log("\n── production (READ-ONLY) ──");
  const axiaro = await prisma.seller.findFirst({ where: { displayName: "Axiaro" }, select: { id: true, type: true, status: true } });
  ok("prod · Axiaro is still FIRST_PARTY / APPROVED (untouched)", axiaro?.type === "FIRST_PARTY" && axiaro?.status === "APPROVED", JSON.stringify(axiaro));
  const axiaroOffers = axiaro ? await prisma.offer.count({ where: { sellerId: axiaro.id } }) : -1;
  ok("prod · Axiaro's offer count unchanged (332)", axiaroOffers === 332, String(axiaroOffers));
  const axiaroVerifications = axiaro ? await prisma.sellerVerification.count({ where: { sellerId: axiaro.id } }) : -1;
  ok("prod · no SellerVerification row created for Axiaro by this phase", axiaroVerifications === 0, String(axiaroVerifications));

  const styleAvenue = await prisma.seller.findFirst({ where: { displayName: "Style Avenue" }, select: { id: true, type: true, status: true } });
  ok("prod · Style Avenue is still THIRD_PARTY / APPROVED (untouched)", styleAvenue?.type === "THIRD_PARTY" && styleAvenue?.status === "APPROVED", JSON.stringify(styleAvenue));
  const saOffer = styleAvenue
    ? await prisma.offer.findFirst({ where: { sellerId: styleAvenue.id }, select: { id: true, status: true, condition: true } })
    : null;
  ok("prod · Style Avenue's existing offer is STILL ACTIVE (this phase never deactivates existing offers)", saOffer?.status === "ACTIVE" && saOffer?.condition === "NEW", JSON.stringify(saOffer));
  const saVerifications = styleAvenue ? await prisma.sellerVerification.count({ where: { sellerId: styleAvenue.id } }) : -1;
  ok("prod · no SellerVerification row created for Style Avenue by this phase", saVerifications === 0, String(saVerifications));

  const sandbox = await prisma.seller.findFirst({ where: { displayName: "Sandbox Seller (dev)" }, select: { id: true, status: true } });
  ok("prod · Sandbox Seller's Seller.status untouched", sandbox?.status === "APPROVED", JSON.stringify(sandbox));

  ok("prod · no leaked p6v fixtures anywhere", (await prisma.seller.count({ where: { slug: { contains: "p6v-" } } })) === 0);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
