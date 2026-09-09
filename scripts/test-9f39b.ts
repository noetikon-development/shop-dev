/**
 * PHASE 9F-39B — CMS global seller commission (default only).
 *
 * A new `StoreSetting` key `marketplace.defaultCommissionBps` (Admin → Settings
 * → Marketplace, 0–5000 bps) is the GLOBAL default commission for a NEWLY
 * created third-party seller. It seeds `Seller.commissionRate` at creation and
 * NOTHING else — checkout, settlement, refunds and existing sellers/orders are
 * untouched. Checkout resolves the rate through a pure
 * `resolveSellerCommissionBps(seller)` (FIRST_PARTY → 0; THIRD_PARTY →
 * `seller.commissionRate`) and freezes it onto SellerOrder / OrderItem exactly
 * as before. NULL-means-inherit seller overrides are explicitly NOT in scope.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f39b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { resolveSellerCommissionBps } from "@/lib/marketplace/commission";
import {
  getDefaultCommissionBps,
  isValidCmsCommissionBps,
  MARKETPLACE_DEFAULT_COMMISSION_KEY,
  COMMISSION_BPS_CMS_MAX,
} from "@/lib/marketplace/commission-config";
import { DEFAULT_SELLER_COMMISSION_BPS, validateCommissionBps } from "@/lib/admin/sellers/lifecycle";
import { createSeller, updateSellerConfig } from "@/lib/admin/sellers/repository";
import { getSellerSettlementPreview, sellerReceivable } from "@/lib/marketplace/settlement";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
class Rollback extends Error {}
type Tx = Prisma.TransactionClient;

function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

// The checkout commission expression — keep in sync with src/lib/checkout.ts.
const checkoutCommission = (seller: { type: string; commissionRate: number }, subtotal: number) => {
  const bps = resolveSellerCommissionBps(seller);
  return { bps, amount: roundHalfUp((subtotal * bps) / 10000) };
};

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — resolver + validation ──");

  // 16 / 29 — FIRST_PARTY always 0, cannot inherit
  ok("16 · FIRST_PARTY → 0 regardless of commissionRate", resolveSellerCommissionBps({ type: "FIRST_PARTY", commissionRate: 0 }) === 0);
  ok("29 · FIRST_PARTY → 0 even if a row carries 1500 / a global is passed",
    resolveSellerCommissionBps({ type: "FIRST_PARTY", commissionRate: 1500 }, 1500) === 0 &&
    resolveSellerCommissionBps({ type: "FIRST_PARTY", commissionRate: null }, 9999) === 0);

  // THIRD_PARTY → own stored rate (global NOT applied this phase)
  ok("resolver · THIRD_PARTY → its own stored commissionRate (1500)", resolveSellerCommissionBps({ type: "THIRD_PARTY", commissionRate: 1500 }) === 1500);
  ok("resolver · THIRD_PARTY 1200 → 1200 (global default is NOT an override this phase)",
    resolveSellerCommissionBps({ type: "THIRD_PARTY", commissionRate: 1200 }, 1500) === 1200);
  ok("resolver · defensive — THIRD_PARTY with no numeric rate falls back to globalBps, else 0",
    resolveSellerCommissionBps({ type: "THIRD_PARTY", commissionRate: null }, 1500) === 1500 &&
    resolveSellerCommissionBps({ type: "THIRD_PARTY", commissionRate: null }) === 0);

  // 1–9 — CMS validation range (0–5000 integer bps)
  ok("2 · 1500 valid", isValidCmsCommissionBps(1500) && isValidCmsCommissionBps("1500"));
  ok("3 · 1200 valid", isValidCmsCommissionBps(1200));
  ok("4 · 0 valid", isValidCmsCommissionBps(0) && isValidCmsCommissionBps("0"));
  ok("5 · 5000 valid (the CMS ceiling)", isValidCmsCommissionBps(5000) && COMMISSION_BPS_CMS_MAX === 5000);
  ok("6 · -1 rejected", !isValidCmsCommissionBps(-1) && !isValidCmsCommissionBps("-1"));
  ok("7 · 5001 rejected by the CMS bound", !isValidCmsCommissionBps(5001));
  ok("8 · 10001 rejected (well past both bounds)", !isValidCmsCommissionBps(10001));
  ok("9 · 1500.5 (decimal) rejected", !isValidCmsCommissionBps(1500.5) && !isValidCmsCommissionBps("1500.5"));
  ok("9 · empty / junk rejected", !isValidCmsCommissionBps("") && !isValidCmsCommissionBps("  ") && !isValidCmsCommissionBps("abc"));

  // the defensive commission validator still bars > 10000
  ok("defensive · validateCommissionBps rejects 10001 and -1 and decimals",
    !validateCommissionBps(10001).ok && !validateCommissionBps(-1).ok && !validateCommissionBps(1500.5).ok &&
    validateCommissionBps(1500).ok && validateCommissionBps(0).ok);

  // 17 / 18 — commission formula: base + rounding unchanged
  ok("17 · formula: roundHalfUp((subtotal * bps) / 10000) — 119900 @ 1500 = 17985 (matches prod)",
    checkoutCommission({ type: "THIRD_PARTY", commissionRate: 1500 }, 119900).amount === 17985);
  ok("17 · half-up boundary — subtotal 100 @ 1250 bps → 12.5 → 13", roundHalfUp((100 * 1250) / 10000) === 13);
  ok("18 · base is the (discounted) selling-price subtotal — a lower subtotal → lower commission",
    checkoutCommission({ type: "THIRD_PARTY", commissionRate: 1500 }, 100000).amount === 15000 &&
    checkoutCommission({ type: "THIRD_PARTY", commissionRate: 1500 }, 90000).amount === 13500);
  ok("16 · FIRST_PARTY order → commission 0", checkoutCommission({ type: "FIRST_PARTY", commissionRate: 0 }, 500000).amount === 0);
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const registry = read("src/lib/admin/settings-registry.ts");
  const settingsActions = read("src/lib/admin/settings-actions.ts");
  const commissionMod = read("src/lib/marketplace/commission.ts");
  const configMod = read("src/lib/marketplace/commission-config.ts");
  const checkout = read("src/lib/checkout.ts");
  const checkoutCode = strip(checkout);
  const sellersRepo = read("src/lib/admin/sellers/repository.ts");
  const newSellerPage = read("src/app/admin/(shell)/sellers/new/page.tsx");
  const settlement = read("src/lib/marketplace/settlement.ts");
  const returnsAdmin = read("src/lib/admin/returns-actions.ts");
  const returnsRepo = read("src/lib/marketplace/seller-return-repository.ts");
  const sellersActions = read("src/lib/admin/sellers/actions.ts");
  const configForm = read("src/components/admin/sellers/seller-config-form.tsx");

  // A — CMS setting
  ok("A · SettingGroupKey + SETTING_GROUPS gain 'marketplace'",
    /\|\s*"marketplace";/.test(registry) && /marketplace: \{\s*\n\s*label: "Marketplace",/.test(registry));
  ok("A · registry field marketplace.defaultCommissionBps — type number, default 1500, future-orders help",
    /key: "marketplace\.defaultCommissionBps"/.test(registry) &&
    /type: "number",\s*\n\s*group: "marketplace",\s*\n\s*default: 1500,/.test(registry) &&
    /Applies to future orders only/.test(registry));
  ok("A · marketplace.multiSellerCheckout still NOT added to the registry", !/marketplace\.multiSellerCheckout/.test(registry));

  // C — dedicated validation bound
  ok("C · settings-actions validates marketplace.defaultCommissionBps with its own 0–5000 bound (not the generic 0–1e9)",
    /field\.key === MARKETPLACE_DEFAULT_COMMISSION_KEY/.test(settingsActions) &&
    /n > COMMISSION_BPS_CMS_MAX/.test(settingsActions) &&
    /Number\.isInteger\(n\)/.test(settingsActions.slice(settingsActions.indexOf("MARKETPLACE_DEFAULT_COMMISSION_KEY"))));
  ok("C · empty value returns a field error (never overwrites)",
    /if \(v === ""\) return \{ error:/.test(settingsActions.slice(settingsActions.indexOf("field.key === MARKETPLACE_DEFAULT_COMMISSION_KEY"))));

  // D — reader
  ok("D · commission-config.ts exports getDefaultCommissionBps + the key + the CMS bounds",
    /export async function getDefaultCommissionBps/.test(configMod) &&
    /export const MARKETPLACE_DEFAULT_COMMISSION_KEY = "marketplace\.defaultCommissionBps"/.test(configMod) &&
    /export const COMMISSION_BPS_CMS_MAX = 5000/.test(configMod));
  ok("D · reader is server-only + uncached (no unstable_cache / react cache) — like getReturnsConfig",
    /"server-only"/.test(configMod) && !/unstable_cache|from "react"/.test(configMod));
  ok("D · reader falls back to DEFAULT_SELLER_COMMISSION_BPS on missing / invalid / out-of-range",
    /return DEFAULT_SELLER_COMMISSION_BPS;/.test(configMod) && /catch \{\s*\n\s*return DEFAULT_SELLER_COMMISSION_BPS;/.test(configMod));

  // E — resolver
  ok("E · commission.ts is a pure client-safe module (no server-only, no prisma import)",
    !/"server-only"/.test(commissionMod) && !/from "@\/lib\/prisma"/.test(commissionMod) && /export function resolveSellerCommissionBps/.test(commissionMod));
  ok("E · resolver: FIRST_PARTY → 0, else seller.commissionRate (global is NOT an override)",
    /if \(seller\.type === "FIRST_PARTY"\) return 0;/.test(commissionMod) &&
    /const own = seller\.commissionRate;/.test(commissionMod));

  // F/G — checkout
  ok("F/G · checkout resolves via resolveSellerCommissionBps(soSeller) and freezes it",
    /const commissionRateBps = resolveSellerCommissionBps\(soSeller\);/.test(checkoutCode) &&
    /const sellerCommissionAmount = roundHalfUp\(\(subtotal \* commissionRateBps\) \/ 10000\);/.test(checkoutCode));
  ok("F/G · SellerOrder.create + OrderItem.createMany snapshot commissionRate: commissionRateBps",
    (checkoutCode.match(/commissionRate: commissionRateBps,/g) ?? []).length === 2 &&
    !/commissionRate: soSeller\.commissionRate/.test(checkoutCode));
  ok("G · checkout never reads the CMS setting (no getDefaultCommissionBps / marketplace.defaultCommissionBps in checkout.ts)",
    !/getDefaultCommissionBps|defaultCommissionBps/.test(checkout));
  ok("G · commission base + rounding unchanged (subtotal, /10000, roundHalfUp)",
    /const subtotal = lines\.reduce\(\(n, l\) => n \+ l\.lineTotal, 0\);/.test(checkout) &&
    /function roundHalfUp/.test(checkout));

  // F — new seller creation
  ok("F · createSeller seeds the rate from getDefaultCommissionBps(client) when none is typed",
    /const seededRate = input\.commissionRate \?\? \(await getDefaultCommissionBps\(client\)\);/.test(sellersRepo) &&
    !/DEFAULT_SELLER_COMMISSION_BPS/.test(sellersRepo));
  ok("F · the New-seller admin page prefills from getDefaultCommissionBps()",
    /getDefaultCommissionBps\(\)/.test(newSellerPage) && !/DEFAULT_SELLER_COMMISSION_BPS/.test(newSellerPage));

  // I — audit
  ok("I · settings-actions writes seller_commission.updated with scope/previous/new/actor, only on a real change",
    /action: "seller_commission\.updated"/.test(settingsActions) &&
    /scope: "global",\s*\n\s*previous: commissionPrevBps,\s*\n\s*new: nextBps,\s*\n\s*actor: admin\.user\.id,/.test(settingsActions) &&
    /commissionPrevBps !== nextBps/.test(settingsActions));

  // J — per-seller admin commission untouched
  ok("J · Admin → Sellers per-seller commission field is unchanged (still commissionRate bps 0–10000, no 'global default' toggle)",
    /name="commissionRate"/.test(configForm) && !/global default/i.test(configForm) &&
    /commissionRate: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(10000\)/.test(sellersActions));

  // K/26/27 — settlement + returns never read the live setting
  ok("26 · settlement.ts does not import/read the CMS commission setting or the resolver",
    !/commission-config|getDefaultCommissionBps|resolveSellerCommissionBps|defaultCommissionBps/.test(settlement) &&
    /return so\.total - so\.commissionAmount;/.test(settlement));
  ok("27 · refund/return code uses the FROZEN SellerOrder.commissionRate, never the CMS setting",
    /roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\)/.test(returnsAdmin) &&
    /roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\)/.test(returnsRepo) &&
    !/commission-config|getDefaultCommissionBps|defaultCommissionBps/.test(returnsAdmin) &&
    !/commission-config|getDefaultCommissionBps|defaultCommissionBps/.test(returnsRepo));

  // 25 — resolver is only in the new-order path
  ok("25 · resolveSellerCommissionBps is referenced ONLY by checkout.ts (+ its own module + this test)", (() => {
    const hits = ["src/lib/checkout.ts", "src/lib/marketplace/settlement.ts", "src/lib/admin/returns-actions.ts",
      "src/lib/marketplace/seller-return-repository.ts", "src/lib/admin/seller-orders.ts", "src/lib/data.ts",
      "src/lib/marketplace/seller-order-repository.ts"]
      .filter((f) => /resolveSellerCommissionBps/.test(read(f)));
    return hits.length === 1 && hits[0] === "src/lib/checkout.ts";
  })());

  // scope
  ok("scope · seed-rbac.ts untouched", !/9F-39B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · no schema change — Seller/SellerOrder/OrderItem commission columns unchanged",
    !/9F-39B/.test(read("prisma/schema.prisma")) &&
    /commissionRate Int\s+@default\(0\)/.test(read("prisma/schema.prisma")));
  ok("scope · coupon economics untouched (discountFundedBy still PLATFORM, no change near it)",
    /discountFundedBy: "PLATFORM",/.test(checkout));
}

// ── DB fixtures (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const fp = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true, type: true, commissionRate: true } });
  const styleAvenue = await prisma.seller.findFirst({ where: { slug: "style-avenue" }, select: { id: true, commissionRate: true } });
  if (!category || !fp || !styleAvenue) { ok("(skipped — no category / FP seller / style-avenue)", true); return; }

  const before = {
    sellers: await prisma.seller.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    styleAvenueRate: styleAvenue.commissionRate,
    fpRate: fp.commissionRate,
  };
  const sfx = "9f39b-" + Date.now().toString(36);

  try {
    await prisma.$transaction(async (tx: Tx) => {
      // 1 — CMS default absent → 1500
      await tx.storeSetting.deleteMany({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY } });
      ok("1 · getDefaultCommissionBps() with no row → 1500", (await getDefaultCommissionBps(tx)) === DEFAULT_SELLER_COMMISSION_BPS);

      // 10 — new seller created with default 1500 → Seller.commissionRate = 1500
      const s1 = await createSeller({ displayName: `S1 ${sfx}`, slug: `s1-${sfx}`, supportEmail: `s1-${sfx}@t.test` }, tx);
      ok("10 · new seller (no rate typed, no CMS row) → commissionRate 1500",
        s1.ok && (await tx.seller.findUnique({ where: { id: s1.ok ? s1.sellerId : "" }, select: { commissionRate: true } }))?.commissionRate === 1500);

      // 3/11 — CMS default 1200 → next new seller gets 1200
      await tx.storeSetting.create({ data: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY, value: "1200", type: "number", label: "x", group: "settings:marketplace" } });
      ok("3 · getDefaultCommissionBps() reads 1200 from the row", (await getDefaultCommissionBps(tx)) === 1200);
      const s2 = await createSeller({ displayName: `S2 ${sfx}`, slug: `s2-${sfx}`, supportEmail: `s2-${sfx}@t.test` }, tx);
      ok("11 · new seller AFTER the CMS change → commissionRate 1200",
        s2.ok && (await tx.seller.findUnique({ where: { id: s2.ok ? s2.sellerId : "" }, select: { commissionRate: true } }))?.commissionRate === 1200);

      // 12 — the CMS change did NOT touch the earlier seller or the real sellers
      ok("12 · seller S1 stays 1500 after the CMS default moved to 1200",
        (await tx.seller.findUnique({ where: { id: s1.ok ? s1.sellerId : "" }, select: { commissionRate: true } }))?.commissionRate === 1500);
      ok("12 · Style Avenue (real seller) unchanged — still 1500, not re-seeded",
        (await tx.seller.findUnique({ where: { id: styleAvenue.id }, select: { commissionRate: true } }))?.commissionRate === 1500);
      ok("12 · Axiaro FIRST_PARTY unchanged — still 0", (await tx.seller.findUnique({ where: { id: fp.id }, select: { commissionRate: true } }))?.commissionRate === 0);

      // 4/5 — CMS 0 and 5000 are valid and used
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "0" } });
      ok("4 · CMS default 0 → getDefaultCommissionBps 0; new seller commissionRate 0", (await getDefaultCommissionBps(tx)) === 0);
      const s0 = await createSeller({ displayName: `S0 ${sfx}`, slug: `s0-${sfx}`, supportEmail: `s0-${sfx}@t.test` }, tx);
      ok("4 · new seller at CMS default 0 → commissionRate 0", s0.ok && (await tx.seller.findUnique({ where: { id: s0.ok ? s0.sellerId : "" }, select: { commissionRate: true } }))?.commissionRate === 0);
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "5000" } });
      ok("5 · CMS default 5000 → getDefaultCommissionBps 5000", (await getDefaultCommissionBps(tx)) === 5000);

      // 7/8 — a raw out-of-range row is clamped / ignored, never grants > 50%
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "8000" } });
      ok("7/8 · a raw row of 8000 bps is clamped to the 5000 CMS ceiling", (await getDefaultCommissionBps(tx)) === 5000);
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "50000" } });
      ok("8 · a raw row past the hard 10000 ceiling → falls back to 1500", (await getDefaultCommissionBps(tx)) === DEFAULT_SELLER_COMMISSION_BPS);
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "1500.5" } });
      ok("9 · a raw decimal row → falls back to 1500", (await getDefaultCommissionBps(tx)) === DEFAULT_SELLER_COMMISSION_BPS);
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "" } });
      ok("30 · an empty row does not resolve to 0% — falls back to 1500", (await getDefaultCommissionBps(tx)) === DEFAULT_SELLER_COMMISSION_BPS);

      // 28 — existing per-seller commission editing still works (unchanged path)
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "1500" } });
      const edited = await updateSellerConfig(s1.ok ? s1.sellerId : "", { commissionRate: 1000 }, tx);
      ok("28 · updateSellerConfig still sets an explicit per-seller rate (1000), independent of the CMS default",
        edited.ok && (await tx.seller.findUnique({ where: { id: s1.ok ? s1.sellerId : "" }, select: { commissionRate: true } }))?.commissionRate === 1000);

      // 13/14/15/21/22 — build a real THIRD_PARTY SellerOrder, then move the CMS default, prove immutability
      const product = await tx.product.create({
        data: { name: `P ${sfx}`, slug: `p-${sfx}`, brand: "Axiaro", shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 5000 },
        select: { id: true },
      });
      const seller = await tx.seller.findUniqueOrThrow({ where: { id: styleAvenue.id }, select: { id: true, type: true, commissionRate: true, displayName: true, supportEmail: true } });
      const subtotal = 119900;
      const { bps, amount } = checkoutCommission(seller, subtotal);
      ok("15 · a new order resolves the seller's own rate (1500) → commission 17985", bps === 1500 && amount === 17985);
      const order = await tx.order.create({
        data: { orderNumber: `AX-${sfx}`, email: "b@e.test", phone: "+639000000000", status: "PROCESSING", paymentMethod: "NONE", paymentStatus: "PENDING",
          subtotal, shippingFee: 0, discountTotal: 0, grandTotal: subtotal, deliveredAt: new Date(Date.now() - 60 * 86400_000), placedAt: new Date(Date.now() - 60 * 86400_000),
          shippingAddress: JSON.stringify({ firstName: "B", line1: "1", city: "M", province: "N", postalCode: "1000", country: "PH" }) },
        select: { id: true, orderNumber: true },
      });
      const so = await tx.sellerOrder.create({
        data: { orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: seller.type, supportEmail: seller.supportEmail,
          commissionRate: bps, merchandiseSubtotal: subtotal, discountAllocated: 0, shippingFee: 0, platformShippingSubsidy: 0, freeShippingApplied: false,
          discountFundedBy: "PLATFORM", commissionAmount: amount, total: subtotal, status: "DELIVERED", settlementStatus: "PENDING_CAPTURE" },
        select: { id: true, commissionRate: true, commissionAmount: true, total: true },
      });
      await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, commissionRate: bps, productId: product.id, name: "I", unitPrice: subtotal, quantity: 1, lineTotal: subtotal } });
      await tx.order.update({ where: { id: order.id }, data: { status: "DELIVERED", paymentStatus: "PAID" } });

      // move the CMS default
      await tx.storeSetting.update({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY }, data: { value: "1200" } });
      const soAfter = await tx.sellerOrder.findUniqueOrThrow({ where: { id: so.id }, select: { commissionRate: true, commissionAmount: true, total: true } });
      const oiAfter = await tx.orderItem.findFirstOrThrow({ where: { sellerOrderId: so.id }, select: { commissionRate: true } });
      ok("13 · existing SellerOrder.commissionRate stays 1500 after CMS → 1200", soAfter.commissionRate === 1500);
      ok("14 · existing SellerOrder.commissionAmount stays 17985 after CMS → 1200", soAfter.commissionAmount === 17985);
      ok("13 · existing OrderItem.commissionRate stays 1500", oiAfter.commissionRate === 1500);

      // 21 — settlement uses the frozen values, unaffected by the CMS change
      const preview = await getSellerSettlementPreview(seller.id, tx);
      const row = preview.eligibleOrders.find((e) => e.orderNumber === order.orderNumber);
      ok("21 · settlement preview: receivable = frozen total − frozen commissionAmount (119900 − 17985 = 101915)",
        !!row && row.commissionAmount === 17985 && row.receivable === 101915 && sellerReceivable(soAfter) === 101915);

      // 22 — a return correction uses the frozen SellerOrder.commissionRate
      const returnedValue = subtotal; // full return
      const commissionAdjustment = roundHalfUp((returnedValue * soAfter.commissionRate) / 10000);
      ok("22 · return commission correction uses frozen 1500 → adjustment 17985 (NOT the new 1200 → 14388)",
        commissionAdjustment === 17985);

      // 19 — compareAt has zero effect: same seller, an offer with a compare-at, identical commission
      const v = await tx.variant.create({ data: { productId: product.id, sku: `v-${sfx}`, price: subtotal, compareAtPrice: 200000, status: "ACTIVE", stock: 10 }, select: { id: true } });
      const offer = await tx.offer.create({ data: { sellerId: seller.id, variantId: v.id, price: subtotal, compareAtPrice: 200000, condition: "NEW", status: "ACTIVE", sellerSku: `os-${sfx}` }, select: { price: true, compareAtPrice: true } });
      ok("19 · commission base = offer.price (119900), compareAtPrice (200000) ignored",
        checkoutCommission(seller, offer.price).amount === 17985);

      // 20 — coupon: commission on pre-coupon subtotal
      ok("20 · a ₱200 coupon does not change commission — still computed on the pre-coupon subtotal",
        checkoutCommission(seller, subtotal).amount === 17985);

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  const after = {
    sellers: await prisma.seller.count(),
    sellerOrders: await prisma.sellerOrder.count(),
    styleAvenueRate: (await prisma.seller.findFirstOrThrow({ where: { slug: "style-avenue" }, select: { commissionRate: true } })).commissionRate,
    fpRate: (await prisma.seller.findFirstOrThrow({ where: { type: "FIRST_PARTY" }, select: { commissionRate: true } })).commissionRate,
  };
  ok("rollback · Seller count unchanged", after.sellers === before.sellers);
  ok("rollback · SellerOrder count unchanged", after.sellerOrders === before.sellerOrders);
  ok("rollback · Style Avenue commissionRate unchanged (1500)", after.styleAvenueRate === before.styleAvenueRate && after.styleAvenueRate === 1500);
  ok("rollback · Axiaro FIRST_PARTY commissionRate unchanged (0)", after.fpRate === before.fpRate && after.fpRate === 0);
  ok("rollback · no marketplace.defaultCommissionBps row leaked into prod",
    (await prisma.storeSetting.count({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY } })) === 0);
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  ok("prod · marketplace.defaultCommissionBps NOT seeded into prod (registry default 1500 supplies it)",
    (await prisma.storeSetting.count({ where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY } })) === 0);
  ok("prod · getDefaultCommissionBps() → 1500 (fallback, no row)", (await getDefaultCommissionBps()) === 1500);
  const sellers = await prisma.seller.findMany({ select: { slug: true, type: true, commissionRate: true } });
  ok("prod · sellers unchanged — axiaro 0, style-avenue 1500, sandbox-seller 1500",
    sellers.find((s) => s.slug === "axiaro")?.commissionRate === 0 &&
    sellers.find((s) => s.slug === "style-avenue")?.commissionRate === 1500 &&
    sellers.find((s) => s.slug === "sandbox-seller")?.commissionRate === 1500);
  const soRates = await prisma.sellerOrder.groupBy({ by: ["commissionRate"], _count: true });
  ok("prod · SellerOrder commissionRate distribution unchanged (0 ×6, 1500 ×3)",
    JSON.stringify(soRates.map((r) => [r.commissionRate, r._count]).sort()) === JSON.stringify([[0, 6], [1500, 3]]));
  ok("prod · SellerOrder commissionAmount unchanged (Σ = 35970 across the 3P orders)",
    (await prisma.sellerOrder.aggregate({ _sum: { commissionAmount: true } }))._sum.commissionAmount === 35970);
}

async function main() {
  console.log("\nPHASE 9F-39B — CMS global seller commission (default only)\n");
  pureTests();
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
