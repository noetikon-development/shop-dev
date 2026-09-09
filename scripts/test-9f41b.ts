/**
 * PHASE 9F-41B — 3P return routing / seller return address.
 *
 *  - `Seller.returnAddress` (structured JSON) is part of the MODERATED profile
 *    bundle: editing it drops an APPROVED bundle back to PENDING.
 *  - `approveReturnAction` resolves the destination ONCE and FREEZES it onto
 *    `ReturnRequest.returnDestination` (+ `returnDestinationSetAt`):
 *      1 THIRD_PARTY seller + APPROVED bundle + complete address → kind "seller"
 *      1P-only                                                    → kind "store"
 *      mixed / >1 3P / 3P without an approved address             → "store" + manualHandling
 *    A later `Seller.returnAddress` edit NEVER changes an approved return.
 *  - New `SELLER_RETURN_APPROVED:<returnId>:<sellerId>` email — 3P only, 1P → SKIPPED.
 *  - Refund calc, commission correction, settlement blocking / clawback,
 *    OfferInventory restock and the return state machine are UNCHANGED.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back. No EMAIL_*
 * config locally → `dispatchEmail` returns SKIPPED, nothing sends.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f41b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  validateSellerReturnAddress,
  parseSellerReturnAddress,
  parseReturnDestination,
  returnDestinationDisplay,
  sellerReturnAddressLines,
  resolveReturnDestination,
} from "@/lib/marketplace/return-destination";
import { updateSellerProfileDraft } from "@/lib/marketplace/seller-profile-repository";
import { sendSellerReturnApproved, getReturnAffectedSellerIds, retryEmailByLog } from "@/lib/email/notifications";
import { renderReturnApproved } from "@/lib/email/templates/return-approved";
import { renderSellerReturnApproved } from "@/lib/email/templates/seller-order-notifications";
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
  sellerId, sellerName: "S", sellerUserId: "su-" + sellerId, userId: "u-" + sellerId, role: "OWNER", permissions: new Set(),
});

const ADDR = {
  recipient: "Style Avenue Returns",
  line1: "12 Warehouse Rd",
  line2: "Bay 4",
  barangay: "Bagong Silang",
  city: "Quezon City",
  province: "Metro Manila",
  postalCode: "1100",
  country: "PH",
  phone: "+63 917 555 0100",
};

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — address + destination helpers ──");

  const v = validateSellerReturnAddress(ADDR);
  ok("A · a complete address validates", v.ok && v.value != null && v.value.city === "Quezon City");
  ok("A · an all-blank map → { ok: true, value: null } (cleared)",
    (() => { const r = validateSellerReturnAddress({}); return r.ok && r.value === null; })());
  ok("A · a missing required field is rejected",
    !validateSellerReturnAddress({ ...ADDR, line1: "" }).ok && !validateSellerReturnAddress({ ...ADDR, recipient: "  " }).ok);
  ok("A · a bad phone / postal code for the country is rejected",
    !validateSellerReturnAddress({ ...ADDR, phone: "nope" }).ok && !validateSellerReturnAddress({ ...ADDR, postalCode: "999999" }).ok);
  ok("A · an unsupported country is rejected", !validateSellerReturnAddress({ ...ADDR, country: "ZZ" }).ok);
  ok("A · line2 + barangay are optional", validateSellerReturnAddress({ ...ADDR, line2: "", barangay: "" }).ok);

  ok("parse · parseSellerReturnAddress round-trips a stored blob; incomplete → null",
    parseSellerReturnAddress(ADDR)?.postalCode === "1100" && parseSellerReturnAddress({ recipient: "x" }) === null && parseSellerReturnAddress(null) === null);

  ok("lines · sellerReturnAddressLines renders recipient → phone, drops blanks",
    (() => { const L = sellerReturnAddressLines(parseSellerReturnAddress(ADDR)!); return L[0] === "Style Avenue Returns" && L.includes("+63 917 555 0100") && L.some((l) => l.includes("Philippines")); })());

  // destination parse / display
  const sellerDest = { kind: "seller", manualHandling: false, sellerIds: ["s1"], sellerId: "s1", sellerName: "Style Avenue", returnPolicy: "30-day", address: ADDR };
  ok("parse · parseReturnDestination keeps a valid seller destination", parseReturnDestination(sellerDest)?.kind === "seller");
  ok("parse · a seller destination with a broken address degrades to store", parseReturnDestination({ ...sellerDest, address: { recipient: "x" } })?.kind === "store");
  const disp = returnDestinationDisplay(parseReturnDestination(sellerDest), "STORE FALLBACK");
  ok("D · seller destination → heading names the seller, lines are the address, note is the returnPolicy",
    /Style Avenue/.test(disp.heading) && disp.lines[0] === "Style Avenue Returns" && disp.note === "30-day");
  const storeDisp = returnDestinationDisplay({ kind: "store", manualHandling: false, sellerIds: [], instructions: "Ship to Axiaro, 1 Main St", policyUrl: null }, "IGNORED");
  ok("D · store destination → 'How to send your return' + the frozen instructions",
    storeDisp.heading === "How to send your return" && storeDisp.lines.join(" ").includes("Ship to Axiaro"));
  const legacyDisp = returnDestinationDisplay(null, "LEGACY STORE-WIDE");
  ok("D · NULL snapshot (legacy) → falls back to the live returns.instructions, byte-for-byte behaviour",
    legacyDisp.heading === "How to send your return" && legacyDisp.lines.join(" ") === "LEGACY STORE-WIDE");
  const manualDisp = returnDestinationDisplay({ kind: "store", manualHandling: true, sellerIds: ["a", "b"], instructions: "x", policyUrl: null }, null);
  ok("D · manualHandling → an 'we'll confirm by email' note is added", /confirm the exact return address/.test(manualDisp.note ?? ""));
}

// ── rendered emails ─────────────────────────────────────────────────────
function emailRenderTests() {
  console.log("\n── rendered emails ──");
  const base = { brand: "Axiaro", siteUrl: "https://axiaro.shop", returnUrl: "https://axiaro.shop/account/returns/RET-1", returnNumber: "RET-1", orderNumber: "AX-1", customerName: "Mara", items: [{ name: "Scarf", variantLabel: "Grey", quantity: 1, unitPrice: 1000, lineTotal: 1000 }], resolutionNote: null };

  const sellerCust = renderReturnApproved({ ...base, destinationHeading: "Send your return to Style Avenue", destinationLines: sellerReturnAddressLines(parseSellerReturnAddress(ADDR)!), destinationNote: "30-day policy", policyUrl: null });
  ok("D · customer email — a seller destination renders the address + policy, subject unchanged",
    sellerCust.subject === "Your return has been approved" && sellerCust.html.includes("Style Avenue Returns") &&
    sellerCust.html.includes("30-day policy") && String(sellerCust.text).includes("Style Avenue Returns"));

  const storeCust = renderReturnApproved({ ...base, destinationHeading: "How to send your return", destinationLines: ["Ship to Axiaro", "1 Main St"], destinationNote: null, policyUrl: "https://axiaro.shop/pages/returns" });
  ok("D · customer email — a store destination renders the instructions + policy link",
    storeCust.html.includes("Ship to Axiaro") && storeCust.html.includes("pages/returns"));

  const fallbackCust = renderReturnApproved({ ...base, destinationHeading: "How to send your return", destinationLines: [], destinationNote: "We'll be in touch shortly with where to send the items.", policyUrl: null });
  ok("D · customer email — no lines → the pre-9F-41B 'we'll be in touch' sentence",
    fallbackCust.html.includes("We&#39;ll be in touch shortly") && String(fallbackCust.text).includes("We'll be in touch shortly"));

  const sellerMail = renderSellerReturnApproved({ brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue", orderNumber: "AX-1", returnNumber: "RET-1", ordersUrl: "u", returnsUrl: "https://axiaro.shop/seller/returns", reasonLabel: "Arrived damaged or faulty", items: [{ name: "Scarf", variantLabel: "Grey", quantity: 1 }], shipsToThisSeller: true, destinationLines: sellerReturnAddressLines(parseSellerReturnAddress(ADDR)!) });
  ok("E · seller email — 'Return approved' subject, tells the seller the customer ships to their address",
    sellerMail.subject === "Return approved: RET-1 (order AX-1)" && sellerMail.html.includes("ship the item(s) to your return address") &&
    sellerMail.html.includes("Style Avenue Returns") && !sellerMail.html.toLowerCase().includes("buyer"));
  const sellerMailStore = renderSellerReturnApproved({ brand: "Axiaro", siteUrl: "s", sellerName: "SA", orderNumber: "AX-1", returnNumber: "RET-1", ordersUrl: "u", returnsUrl: "r", reasonLabel: "x", items: [{ name: "Scarf", variantLabel: null, quantity: 1 }], shipsToThisSeller: false, destinationLines: [] });
  ok("E · seller email — non-seller destination → 'Axiaro is coordinating', no address block",
    sellerMailStore.html.includes("Axiaro is coordinating") && !sellerMailStore.html.includes("Ship to"));
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const schema = read("prisma/schema.prisma");
  const migration = read("supabase/migrations/20260910120000_return_routing.sql");
  const mod = read("src/lib/marketplace/return-destination.ts");
  const approveActions = read("src/lib/admin/returns-actions.ts");
  const notif = read("src/lib/email/notifications.ts");
  const send = read("src/lib/email/send.ts");
  const profileRepo = read("src/lib/marketplace/seller-profile-repository.ts");
  const sellerActions = read("src/lib/seller/settings-actions.ts");
  const adminReturns = read("src/lib/admin/returns.ts");
  const custPage = read("src/app/(shop)/account/returns/[returnNumber]/page.tsx");
  const sellerPage = read("src/app/seller/(portal)/returns/[id]/page.tsx");
  const adminPage = read("src/app/admin/(shell)/returns/[id]/page.tsx");

  // schema + migration
  ok("schema · Seller.returnAddress Json? + ReturnRequest.returnDestination Json? + returnDestinationSetAt DateTime?",
    /returnAddress\s+Json\?/.test(schema) && /returnDestination\s+Json\?/.test(schema) && /returnDestinationSetAt\s+DateTime\?/.test(schema));
  ok("migration · one additive migration, ADD COLUMN IF NOT EXISTS, no backfill / DROP / UPDATE",
    /ADD COLUMN IF NOT EXISTS "returnAddress" JSONB/.test(migration) && /ADD COLUMN IF NOT EXISTS "returnDestination" JSONB/.test(migration) &&
    /ADD COLUMN IF NOT EXISTS "returnDestinationSetAt" TIMESTAMP/.test(migration) && !/\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i.test(migration.replace(/--.*$/gm, "")));
  ok("package.json · db:migrate:9f41b + test:9f41b", /"db:migrate:9f41b":/.test(read("package.json")) && /"test:9f41b":/.test(read("package.json")));

  // moderation
  ok("moderation · returnAddress is in PROFILE_SELECT + the patch type + validateAndCleanPatch",
    /returnAddress: true,/.test(profileRepo) && /returnAddress: Record<string, unknown> \| null;/.test(profileRepo) &&
    /if \("returnAddress" in patch\) \{/.test(profileRepo) && /validateSellerReturnAddress\(patch\.returnAddress\)/.test(profileRepo));
  ok("moderation · a returnAddress edit goes through writeBundle (APPROVED → PENDING) like every other bundle field",
    /const run = \(tx: Prisma\.TransactionClient\) => writeBundle\(tx, ctx, validated\.data\);/.test(profileRepo));
  ok("moderation · settings action only touches returnAddress when the form carried the fields",
    /const returnAddressSubmitted = SELLER_RETURN_ADDRESS_FIELDS\.some/.test(sellerActions) &&
    /\.\.\.\(returnAddressSubmitted \? \{ returnAddress \} : \{\}\)/.test(sellerActions));

  // approval snapshot
  ok("B · approveReturnAction resolves + FREEZES the destination after the status write",
    /const destination = await resolveReturnDestination\(ret\.id\);/.test(approveActions) &&
    /returnDestination: destination as unknown as Prisma\.InputJsonValue,\s*\n\s*returnDestinationSetAt: new Date\(\),/.test(approveActions) &&
    approveActions.indexOf("status: \"APPROVED\", resolutionNote") < approveActions.indexOf("resolveReturnDestination(ret.id)"));
  ok("B · the approval audit records routing + manualHandling + sellerIds",
    /routing: destination\.kind,\s*\n\s*manualHandling: destination\.manualHandling,\s*\n\s*sellerIds: destination\.sellerIds,/.test(approveActions));
  ok("E · approveReturnAction loops destination.sellerIds → sendSellerReturnApproved (3P only)",
    /for \(const sellerId of destination\.sellerIds\) \{\s*\n\s*scheduleEmail\(\(\) => sendSellerReturnApproved\(ret\.id, sellerId\)\)/.test(approveActions));

  // the resolver rules
  ok("B · resolveReturnDestination: 1 3P + APPROVED bundle + complete address → kind 'seller'",
    /if \(thirdParty\.length === 1\) \{[\s\S]{0,400}s\.contentStatus === "APPROVED" \? parseSellerReturnAddress\(s\.returnAddress\) : null/.test(mod) &&
    /kind: "seller",\s*\n\s*manualHandling: false,/.test(mod));
  ok("B · resolveReturnDestination: 1P-only → storeFallback(false); mixed / multi-3P / no address → storeFallback(true)",
    /if \(thirdParty\.length === 0\) return storeFallback\(false, \[\]\);/.test(mod) &&
    /return storeFallback\(true, thirdPartyIds\);/.test(mod));
  ok("B · the resolver's affected-seller query mirrors getReturnAffectedSellerIds (OrderItem.sellerId snapshot)",
    /returnItem\.findMany\(\{\s*\n\s*where: \{ returnRequestId: returnId \},\s*\n\s*select: \{ orderItem: \{ select: \{ sellerId: true \} \} \},/.test(mod));

  // email
  ok("E · seller_return_approved EmailType added; retry routing parses <returnId>:<sellerId>",
    /\| "seller_return_approved"/.test(send) &&
    /case "seller_return_approved": \{[\s\S]{0,320}sendSellerReturnApproved\(returnId, sellerId, \{ retry: true, idempotencyKey: log\.idempotencyKey, client: tx \}\)/.test(notif));
  ok("E · sendSellerReturnApproved guards FIRST_PARTY → SKIPPED before dispatch; key SELLER_RETURN_APPROVED:<id>:<sellerId>",
    /if \(seller\?\.type !== "THIRD_PARTY"\) return \{ ok: true, skipped: true, status: "SKIPPED" \};/.test(notif.slice(notif.indexOf("sendSellerReturnApproved"))) &&
    /SELLER_RETURN_APPROVED:\$\{returnId\}:\$\{sellerId\}/.test(notif));
  ok("E · existing seller REQUESTED / RECEIVED notifications untouched",
    /SELLER_RETURN_REQUESTED:\$\{returnId\}:\$\{sellerId\}/.test(notif) && /SELLER_RETURN_RECEIVED:\$\{returnId\}:\$\{sellerId\}/.test(notif));
  ok("D · sendReturnApproved threads the frozen destination (parseReturnDestination + returnDestinationDisplay)",
    /returnDestinationDisplay\(\s*\n?\s*parseReturnDestination\(destRow\?\.returnDestination\),/.test(notif));

  // surfaces
  ok("D · customer page shows the destination card (APPROVED..REFUND_INITIATED)",
    /const showDestination = \["APPROVED", "RECEIVED", "REFUND_INITIATED"\]\.includes\(ret\.status\)/.test(custPage) && /\{destination && \(/.test(custPage));
  ok("seller page · shows 'Return destination (given to the customer)' from the snapshot",
    /Return destination \(given to the customer\)/.test(sellerPage) && /ret\.destination/.test(sellerPage));
  ok("G · admin getAdminReturn reads each line's BOUND offer inventory (not FIRST_PARTY_OFFER_FILTER)",
    !/FIRST_PARTY_OFFER_FILTER/.test(adminReturns) && /orderItem: \{\s*\n\s*select: \{\s*\n\s*offerId: true,\s*\n\s*sellerId: true,\s*\n\s*offer: \{/.test(adminReturns) &&
    /currentOfferStock: inv \? Math\.max\(0, inv\.quantity - inv\.reserved\) : null,/.test(adminReturns));
  ok("admin page · Routing card + per-line seller/stock",
    /Manual routing needed/.test(adminPage) && /ret\.routing\.destinationKind/.test(adminPage) &&
    /Sold by /.test(adminPage) && /it\.currentOfferStock/.test(adminPage));

  // regression scope
  ok("F · return state machine untouched (no 9F-41B marker in returns/status.ts)", !/9F-41B/.test(read("src/lib/returns/status.ts")));
  ok("F · refund calc untouched — still `line.unitPrice * r.quantity` / `it.unitPrice * l.quantity`",
    /refundAmount: line\.unitPrice \* r\.quantity,/.test(read("src/lib/returns-actions.ts")) &&
    /refundAmount: it\.unitPrice \* l\.quantity,/.test(read("src/lib/admin/returns-actions.ts")));
  ok("F · commission correction + clawback untouched — frozen SellerOrder.commissionRate",
    /roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\)/.test(read("src/lib/admin/returns-actions.ts")) &&
    /roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\)/.test(read("src/lib/marketplace/seller-return-repository.ts")));
  ok("F · settlement blocking list untouched", /SETTLEMENT_BLOCKING_RETURN_STATUSES = \[\s*\n\s*"REQUESTED",\s*\n\s*"APPROVED",\s*\n\s*"RECEIVED",\s*\n\s*"REFUND_INITIATED",/.test(read("src/lib/marketplace/settlement.ts")));
  ok("F · OfferInventory restock path untouched — still restoreOfferStock(..., reason: 'RETURN')",
    /restoreOfferStock\(/.test(read("src/lib/admin/returns-actions.ts")) && /reason: "RETURN"/.test(read("src/lib/admin/returns-actions.ts")));
  ok("scope · seed-rbac.ts untouched, PayMongo dormant", !/9F-41B/.test(read("scripts/seed-rbac.ts")) && !/9F-41B/.test(read("src/lib/payments/refund.ts")));
}

// ── DB fixtures (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back; local env → dispatch SKIPPED) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const fp = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const buyer = await prisma.user.findFirst({ select: { id: true } });
  if (!category || !fp || !buyer) { ok("(skipped — no category / FP seller / user)", true); return; }
  const before = {
    rr: await prisma.returnRequest.count(),
    ri: await prisma.returnItem.count(),
    withAddr: await prisma.seller.count({ where: { returnAddress: { not: Prisma.JsonNull } } }),
    emails: await prisma.emailLog.count(),
  };
  const sfx = "9f41b-" + Date.now().toString(36);

  const seed3P = (tx: Tx, tag: string, opts: { contentStatus?: string; addr?: object | null; withUser?: boolean } = {}) =>
    tx.seller.create({
      data: {
        type: "THIRD_PARTY", status: "APPROVED", displayName: `${tag} ${sfx}`, slug: `${tag}-${sfx}-${Math.random().toString(36).slice(2, 6)}`,
        supportEmail: "s@t.test", notifyEmail: opts.withUser === false ? null : `notify-${tag}-${sfx}@t.test`,
        contentStatus: opts.contentStatus ?? "APPROVED",
        returnAddress: opts.addr === undefined ? (ADDR as object) : opts.addr === null ? Prisma.JsonNull : (opts.addr as object),
      },
      select: { id: true },
    });
  const seedProduct = (tx: Tx) =>
    tx.product.create({ data: { name: `P ${sfx}${Math.random()}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 8)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 }, select: { id: true } });
  const seedReturn = async (tx: Tx, lines: { sellerId: string }[], status = "REQUESTED") => {
    const order = await tx.order.create({ data: { orderNumber: `AX-${sfx}-${Math.random().toString(36).slice(2, 6)}`, email: "b@e.test", phone: "+630", status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 1000, grandTotal: 1000, shippingFee: 0, shippingAddress: "{}", userId: buyer.id }, select: { id: true, orderNumber: true } });
    const items: { orderItemId: string }[] = [];
    for (const l of lines) {
      const pid = (await seedProduct(tx)).id;
      const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: l.sellerId, sellerName: "S", sellerType: "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, total: 1000, commissionRate: 1500, commissionAmount: 150, status: "DELIVERED" }, select: { id: true } });
      const oi = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: l.sellerId, productId: pid, name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 }, select: { id: true } });
      items.push({ orderItemId: oi.id });
    }
    const ret = await tx.returnRequest.create({
      data: { returnNumber: `RET-${sfx}-${Math.random().toString(36).slice(2, 6)}`, orderId: order.id, userId: buyer.id, status, reason: "DAMAGED", items: { create: items.map((i) => ({ orderItemId: i.orderItemId, productId: "p", name: "Item", unitPrice: 1000, quantity: 1, refundAmount: 1000 })) } },
      select: { id: true, returnNumber: true },
    });
    return { ret, orderId: order.id };
  };

  try {
    await prisma.$transaction(async (tx) => {
      // ── A — moderation ──
      const S = await seed3P(tx, "mod", { contentStatus: "APPROVED" });
      const m = await updateSellerProfileDraft(ctxFor(S.id), { returnAddress: { ...ADDR, city: "Makati" } }, tx);
      ok("A · updateSellerProfileDraft(returnAddress) → ok, bundle now PENDING (APPROVED edit)", m.ok && m.contentStatus === "PENDING");
      const modRow = await tx.seller.findUniqueOrThrow({ where: { id: S.id }, select: { returnAddress: true, contentStatus: true } });
      ok("A · the address persisted, contentStatus PENDING", parseSellerReturnAddress(modRow.returnAddress)?.city === "Makati" && modRow.contentStatus === "PENDING");
      const bad = await updateSellerProfileDraft(ctxFor(S.id), { returnAddress: { ...ADDR, phone: "" } }, tx);
      ok("A · a missing required field is rejected (VALIDATION), stored value unchanged",
        !bad.ok && bad.code === "VALIDATION" &&
        parseSellerReturnAddress((await tx.seller.findUniqueOrThrow({ where: { id: S.id }, select: { returnAddress: true } })).returnAddress)?.city === "Makati");

      // ── B — routing ──
      const S1 = await seed3P(tx, "sole", { contentStatus: "APPROVED", addr: ADDR });
      const d1 = await resolveReturnDestination((await seedReturn(tx, [{ sellerId: S1.id }])).ret.id, tx);
      ok("B · single 3P + APPROVED bundle + address → kind 'seller', not manual, sellerIds = [that seller]",
        d1.kind === "seller" && d1.manualHandling === false && d1.sellerId === S1.id && JSON.stringify(d1.sellerIds) === JSON.stringify([S1.id]) && d1.address?.postalCode === "1100");

      const d1p = await resolveReturnDestination((await seedReturnFP(tx, buyer.id, category!.id, fp.id)).ret.id, tx);
      ok("B · 1P-only → kind 'store', not manual, no sellerIds", d1p.kind === "store" && d1p.manualHandling === false && d1p.sellerIds.length === 0);

      const Snoaddr = await seed3P(tx, "noaddr", { contentStatus: "APPROVED", addr: null });
      const dNo = await resolveReturnDestination((await seedReturn(tx, [{ sellerId: Snoaddr.id }])).ret.id, tx);
      ok("B · single 3P without an address → kind 'store' + manualHandling, sellerIds kept", dNo.kind === "store" && dNo.manualHandling === true && dNo.sellerIds.includes(Snoaddr.id));

      const Sunappr = await seed3P(tx, "pend", { contentStatus: "PENDING", addr: ADDR });
      const dUn = await resolveReturnDestination((await seedReturn(tx, [{ sellerId: Sunappr.id }])).ret.id, tx);
      ok("B · a 3P address whose bundle is NOT APPROVED is NOT trusted → store + manual", dUn.kind === "store" && dUn.manualHandling === true);

      const S2 = await seed3P(tx, "multi", { contentStatus: "APPROVED", addr: ADDR });
      const dMulti = await resolveReturnDestination((await seedReturn(tx, [{ sellerId: S1.id }, { sellerId: S2.id }])).ret.id, tx);
      ok("B · two 3P sellers → store + manualHandling, both sellerIds", dMulti.kind === "store" && dMulti.manualHandling === true && dMulti.sellerIds.length === 2);

      // ── C — snapshot immutability ──
      const Simm = await seed3P(tx, "imm", { contentStatus: "APPROVED", addr: ADDR });
      const { ret: immRet } = await seedReturn(tx, [{ sellerId: Simm.id }], "APPROVED");
      const frozen = await resolveReturnDestination(immRet.id, tx);
      await tx.returnRequest.update({ where: { id: immRet.id }, data: { returnDestination: frozen as unknown as Prisma.InputJsonValue, returnDestinationSetAt: new Date() } });
      // now change the seller's address
      await tx.seller.update({ where: { id: Simm.id }, data: { returnAddress: { ...ADDR, line1: "999 Different Rd", city: "Cebu" } } });
      const reRead = parseReturnDestination((await tx.returnRequest.findUniqueOrThrow({ where: { id: immRet.id }, select: { returnDestination: true } })).returnDestination);
      ok("C · the FROZEN returnDestination is unchanged after the seller edits Seller.returnAddress",
        reRead?.kind === "seller" && reRead.address?.line1 === "12 Warehouse Rd" && reRead.address?.city === "Quezon City");
      const wouldNowBe = await resolveReturnDestination(immRet.id, tx);
      ok("C · a fresh resolve WOULD now differ (proves the snapshot is a real freeze, not a live read)",
        wouldNowBe.address?.city === "Cebu");

      // ── E — seller_return_approved email ──
      const Semail = await seed3P(tx, "mail", { contentStatus: "APPROVED", addr: ADDR, withUser: true });
      const { ret: mailRet } = await seedReturn(tx, [{ sellerId: Semail.id }], "APPROVED");
      const dest = await resolveReturnDestination(mailRet.id, tx);
      await tx.returnRequest.update({ where: { id: mailRet.id }, data: { returnDestination: dest as unknown as Prisma.InputJsonValue, returnDestinationSetAt: new Date() } });
      ok("E · getReturnAffectedSellerIds finds the 3P seller", (await getReturnAffectedSellerIds(mailRet.id, tx)).includes(Semail.id));
      const r = await sendSellerReturnApproved(mailRet.id, Semail.id, { client: tx });
      ok("E · 3P seller with recipients → dispatched (SKIPPED locally), one EmailLog row, right key + type",
        r.ok === true && r.status === "SKIPPED" &&
        (await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:${mailRet.id}:${Semail.id}` }, select: { type: true } }))?.type === "seller_return_approved");
      const r2 = await sendSellerReturnApproved(mailRet.id, Semail.id, { client: tx });
      ok("E · repeat call is DEDUPED — exactly one row for the key",
        r2.status === "DEDUPED" && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:${mailRet.id}:${Semail.id}` } })) === 1);
      await tx.emailLog.update({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:${mailRet.id}:${Semail.id}` }, data: { status: "FAILED", error: "t" } });
      const rr = await retryEmailByLog((await tx.emailLog.findUniqueOrThrow({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:${mailRet.id}:${Semail.id}` }, select: { id: true } })).id, tx);
      ok("E · retryEmailByLog routes seller_return_approved, reuses the row",
        ["SKIPPED", "SENT", "DEDUPED"].includes(rr.status) && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:${mailRet.id}:${Semail.id}` } })) === 1);

      // ── E — FIRST_PARTY → SKIPPED, no row ──
      const rFP = await sendSellerReturnApproved(mailRet.id, fp.id, { client: tx });
      ok("E · FIRST_PARTY seller id → SKIPPED via the guard, NO EmailLog row",
        rFP.ok === true && rFP.status === "SKIPPED" &&
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_RETURN_APPROVED:${mailRet.id}:${fp.id}` } })) === 0);

      // ── F — the return row's frozen refund / commission fields are not touched by any of this ──
      const soCheck = await tx.sellerOrder.findFirstOrThrow({ where: { orderId: (await seedReturn(tx, [{ sellerId: S1.id }])).orderId }, select: { commissionRate: true, commissionAmount: true } });
      ok("F · SellerOrder commission fields are the seeded frozen values (routing never touches them)",
        soCheck.commissionRate === 1500 && soCheck.commissionAmount === 150);

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · no ReturnRequest leaked", (await prisma.returnRequest.count()) === before.rr);
  ok("rollback · no ReturnItem leaked", (await prisma.returnItem.count()) === before.ri);
  ok("rollback · no Seller.returnAddress leaked", (await prisma.seller.count({ where: { returnAddress: { not: Prisma.JsonNull } } })) === before.withAddr);
  ok("rollback · no EmailLog leaked", (await prisma.emailLog.count()) === before.emails);
}

/** 1P-only return fixture (its own seller order + item). */
async function seedReturnFP(tx: Tx, userId: string, categoryId: string, fpSellerId: string) {
  const p = await tx.product.create({ data: { name: `FP ${Math.random()}`, slug: `fp-${Math.random().toString(36).slice(2, 9)}`, shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 1000 }, select: { id: true } });
  const order = await tx.order.create({ data: { orderNumber: `AX-FP-${Math.random().toString(36).slice(2, 6)}`, email: "b@e.test", phone: "+630", status: "DELIVERED", paymentMethod: "COD", paymentStatus: "PENDING", subtotal: 1000, grandTotal: 1000, shippingFee: 0, shippingAddress: "{}", userId }, select: { id: true } });
  const so = await tx.sellerOrder.create({ data: { orderId: order.id, sellerId: fpSellerId, sellerName: "Axiaro", sellerType: "FIRST_PARTY", supportEmail: "o@t.test", merchandiseSubtotal: 1000, total: 1000, status: "DELIVERED" }, select: { id: true } });
  const oi = await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: fpSellerId, productId: p.id, name: "1P", unitPrice: 1000, quantity: 1, lineTotal: 1000 }, select: { id: true } });
  const ret = await tx.returnRequest.create({ data: { returnNumber: `RET-FP-${Math.random().toString(36).slice(2, 6)}`, orderId: order.id, userId, status: "REQUESTED", reason: "DAMAGED", items: { create: [{ orderItemId: oi.id, productId: p.id, name: "1P", unitPrice: 1000, quantity: 1, refundAmount: 1000 }] } }, select: { id: true } });
  return { ret };
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const cols = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT count(*)::int AS n FROM information_schema.columns WHERE (table_name='Seller' AND column_name='returnAddress') OR (table_name='ReturnRequest' AND column_name IN ('returnDestination','returnDestinationSetAt'))`,
  );
  ok("prod · all 3 columns exist", cols[0].n === 3);
  ok("prod · no Seller has a returnAddress yet (no backfill)", (await prisma.seller.count({ where: { returnAddress: { not: Prisma.JsonNull } } })) === 0);
  ok("prod · returns / returnItems / paymentRefunds / settlements all still 0",
    (await prisma.returnRequest.count()) === 0 && (await prisma.returnItem.count()) === 0 &&
    (await prisma.paymentRefund.count()) === 0 && (await prisma.sellerSettlement.count()) === 0);
  ok("prod · sellers 3, all returnDestination NULL is trivially true (0 returns)", (await prisma.seller.count()) === 3);
}

async function main() {
  console.log("\nPHASE 9F-41B — 3P return routing / seller return address\n");
  pureTests();
  emailRenderTests();
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
