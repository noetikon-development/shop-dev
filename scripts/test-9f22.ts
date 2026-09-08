/**
 * PHASE 9F-22 — Product condition / status.
 *
 *  - Official Offer conditions: NEW, REFURBISHED, OPEN_BOX (new), USED_LIKE_NEW,
 *    USED_GOOD. Added to the TS union, repo list, zod, seller forms, label map.
 *  - `updateSellerOffer`: DRAFT/INACTIVE may change condition; ACTIVE may NOT
 *    (seller must go inactive first); ARCHIVED unchanged (already blocked).
 *  - `OrderItem.condition String?` — a faithful checkout snapshot of the bound
 *    Offer's condition (incl. "NEW"); display code shows a line only for non-NEW.
 *  - Card / PDP / order pages / seller_order_received show the non-NEW condition.
 *  - 1P stays implicitly NEW — `ensureFirstPartyOffer` untouched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f22.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { createSellerOffer, updateSellerOffer, setSellerOfferStatus } from "../src/lib/marketplace/seller-repository";
import { conditionLabel, isNoteworthyCondition } from "../src/lib/seller/format";
import { renderSellerOrderReceived, renderSellerOrderCancelled } from "../src/lib/email/templates/seller-order-notifications";
import type { SellerContext } from "../src/lib/marketplace/types";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

function ctxFor(sellerId: string): SellerContext {
  return { sellerId, sellerName: "S", sellerUserId: "su-" + sellerId, userId: "u-" + sellerId, role: "OWNER", permissions: new Set() };
}
async function seedSeller(tx: Tx, slug: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}
async function seedVariant(tx: Tx, categoryId: string) {
  const t = Math.random().toString(36).slice(2, 8);
  const p = await tx.product.create({
    data: { name: `C ${t}`, slug: `c9f22-${t}`, brand: "Axiaro", shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 5000 },
    select: { id: true },
  });
  const v = await tx.variant.create({ data: { productId: p.id, sku: `T9F22-${t.toUpperCase()}`, price: 5000, status: "ACTIVE", stock: 0 }, select: { id: true } });
  await tx.inventory.create({ data: { variantId: v.id, sku: `T9F22-${t.toUpperCase()}`, quantity: 0, reserved: 0, reorderPoint: 3 } });
  return { productId: p.id, variantId: v.id };
}

// ---------------------------------------------------------------------------

function staticTests() {
  console.log("\n── static wiring ──");
  const schema = read("prisma/schema.prisma");
  const types = read("src/lib/marketplace/types.ts");
  const repo = read("src/lib/marketplace/seller-repository.ts");
  const actions = read("src/lib/seller/offer-actions.ts");
  const format = read("src/lib/seller/format.ts");
  const createForm = read("src/components/seller/offer-create-form.tsx");
  const editForm = read("src/components/seller/offer-edit-form.tsx");
  const checkout = read("src/lib/checkout.ts");
  const data = read("src/lib/data.ts");
  const orderDetail = read("src/components/order/order-detail.tsx");
  const notif = read("src/lib/email/notifications.ts");
  const adminSeller = read("src/app/admin/(shell)/sellers/[id]/page.tsx");
  const pdp = read("src/components/pdp/product-viewer.tsx");
  const card = read("src/components/product-card.tsx");

  // 1 — OPEN_BOX in all 6 lists
  ok("union · OfferCondition includes OPEN_BOX", /"NEW" \| "REFURBISHED" \| "OPEN_BOX" \| "USED_LIKE_NEW" \| "USED_GOOD"/.test(types));
  ok("repo · OFFER_CONDITIONS includes OPEN_BOX", /\["NEW", "REFURBISHED", "OPEN_BOX", "USED_LIKE_NEW", "USED_GOOD"\]/.test(repo));
  ok("zod · both offer-action enums include OPEN_BOX", (actions.match(/z\.enum\(\["NEW", "REFURBISHED", "OPEN_BOX", "USED_LIKE_NEW", "USED_GOOD"\]\)/g) ?? []).length === 2);
  ok("label · CONDITION_LABEL maps OPEN_BOX → 'Open box'", /OPEN_BOX: "Open box"/.test(format));
  ok("form · create form lists OPEN_BOX", /\{ value: "OPEN_BOX", label: "Open box" \}/.test(createForm));
  ok("form · edit form lists OPEN_BOX", /\{ value: "OPEN_BOX", label: "Open box" \}/.test(editForm));
  ok("no PRE_OWNED / LIKE_NEW / OTHER token introduced", !/"PRE_OWNED"|"LIKE_NEW"|"OTHER"/.test(types + repo + actions + format));

  // schema
  ok("schema · OrderItem.condition String? added", /model OrderItem \{[\s\S]{0,900}\n\s*condition\s+String\?/.test(schema));
  ok("schema · Offer.condition comment updated, still String @default(\"NEW\")", /condition\s+String\s+@default\("NEW"\) \/\/ NEW \| REFURBISHED \| OPEN_BOX \| USED_LIKE_NEW \| USED_GOOD/.test(schema));
  ok("schema · NO Product.condition", (() => {
    const s = schema.indexOf("\nmodel Product {");
    const block = schema.slice(s, schema.indexOf("\n}", s));
    return s !== -1 && !/\n\s*condition\s+String/.test(block);
  })());
  ok("schema · @@unique([sellerId, variantId, condition]) unchanged", /@@unique\(\[sellerId, variantId, condition\]\)/.test(schema));

  // 4/5 — ACTIVE guard
  ok("guard · ACTIVE offer condition change → VALIDATION 'Make this listing inactive…'", /if \(offer\.status === "ACTIVE"\) \{[\s\S]{0,150}error: "Make this listing inactive before changing its condition\.",/.test(repo));
  ok("guard · sits inside the `patch.condition !== offer.condition` block", repo.indexOf("patch.condition !== offer.condition") < repo.indexOf('if (offer.status === "ACTIVE")') && repo.indexOf('if (offer.status === "ACTIVE")') < repo.indexOf("data.condition = patch.condition"));
  ok("guard · ARCHIVED still blocked from ANY edit (unchanged)", /if \(offer\.status === "ARCHIVED"\) \{\s*return \{ ok: false, code: "VALIDATION", error: "An archived offer can't be edited\." \};/.test(repo));

  // 6 — checkout snapshot
  ok("checkout · bound-offer select includes condition", /offer: \{\s*select: \{[\s\S]{0,600}\n\s*condition: true,/.test(checkout));
  ok("checkout · line carries condition: o.condition (the BOUND offer)", /condition: o\.condition, \/\/ 9F-22 snapshot/.test(checkout));
  ok("checkout · orderItem.createMany writes condition: l.condition", /lineTotal: l\.lineTotal,\s*[\s\S]{0,400}\n\s*condition: l\.condition,/.test(checkout));
  ok("checkout · offer is NOT re-picked (resolveWinningOfferView not called in the writer)", !/resolveWinningOfferView\(/.test(checkout.slice(checkout.indexOf("orderItem.createMany") - 4000, checkout.indexOf("orderItem.createMany"))));

  // 7 — card + PDP
  ok("data · card select adds condition: true (winner + facet queries)", (data.match(/condition: true,\s*\n\s*seller: \{ select: \{ type: true, status: true \} \}/g) ?? []).length >= 2);
  ok("data · cardCondition uses resolveWinningOfferView + non-NEW gate (9F-23c: whole-pool winner)", /function cardCondition\([\s\S]{0,900}resolveWinningOfferView\(candidates\)[\s\S]{0,200}row\.condition !== "NEW"/.test(data));
  ok("data · ProductCardView gets a `condition` field", /condition,\s*\n\s*defaultVariantId:/.test(data));
  ok("card · renders a chip only when product.condition is set", /\{product\.condition && \(\s*<span[\s\S]{0,200}conditionLabel\(product\.condition\)\}/.test(card));
  ok("pdp · seller-info condition row gated on isNoteworthyCondition", /isNoteworthyCondition\(matchedVariant\.offerCondition\)/.test(pdp) && !/\{matchedVariant\.offerCondition && \(/.test(pdp));

  // 8 — order surfaces
  ok("order-detail · condition line gated on isNoteworthyCondition(it.condition)", /isNoteworthyCondition\(it\.condition\)[\s\S]{0,140}Condition: \{conditionLabel\(it\.condition!\)\}/.test(orderDetail));
  ok("order history · summary appends (condition) only for non-NEW", /isNoteworthyCondition\(it\.condition\)\s*\?\s*`\$\{it\.name\} \(\$\{conditionLabel\(it\.condition!\)\}\)`/.test(read("src/app/(shop)/account/orders/page.tsx")));

  // 9 — seller_order_received
  ok("email · sendSellerOrderReceived selects item.condition", /items: \{\s*select: \{ name: true, variantLabel: true, quantity: true, unitPrice: true, lineTotal: true, condition: true \}/.test(notif));
  ok("email · non-NEW folds a 'Condition: …' line into variantLabel; NEW untouched", /isNoteworthyCondition\(i\.condition\)\s*\?\s*\[i\.variantLabel, `Condition: \$\{conditionLabel\(i\.condition!\)\}`\]/.test(notif));
  ok("email · shared itemsTable helper NOT changed for 9F-22", !/9F-22/.test(read("src/lib/email/html.ts")));

  // 10 — admin display
  ok("admin seller page · uses conditionLabel(o.condition)", /\{conditionLabel\(o\.condition\)\}/.test(adminSeller) && !/>\{o\.condition\}</.test(adminSeller));

  // 12/14 — buy-box + 1P untouched
  ok("buy-box · rankOffers / buy-box-rule.ts NOT touched by 9F-22", !/9F-22/.test(read("src/lib/marketplace/buy-box-rule.ts")));
  ok("1P · offer-sync.ts NOT touched by 9F-22 (1P discovery de-NEW'd later in 9F-23b)", !/9F-22/.test(read("src/lib/admin/offer-sync.ts")));
  ok("1P · first-party-inventory.ts NOT touched", !/9F-22/.test(read("src/lib/admin/first-party-inventory.ts")));
  ok("1P · analytics NEW-only queries NOT touched", !/9F-22/.test(read("src/lib/analytics/queries.ts")));
  ok("scope · settlement / payment / reconcile scripts NOT touched", !/9F-22/.test(read("src/lib/marketplace/settlement.ts")) && !/9F-22/.test(read("scripts/reconcile-9e3d.ts")));
  ok("scope · seed-rbac.ts untouched", !/9F-22/.test(read("scripts/seed-rbac.ts")));

  // pure label behaviour
  console.log("\n── pure ──");
  ok("conditionLabel(OPEN_BOX) = 'Open box'", conditionLabel("OPEN_BOX") === "Open box");
  ok("conditionLabel(NEW) = 'New'", conditionLabel("NEW") === "New");
  ok("isNoteworthyCondition: NEW → false, null → false", !isNoteworthyCondition("NEW") && !isNoteworthyCondition(null) && !isNoteworthyCondition(undefined));
  ok("isNoteworthyCondition: OPEN_BOX / REFURBISHED / USED_GOOD → true", isNoteworthyCondition("OPEN_BOX") && isNoteworthyCondition("REFURBISHED") && isNoteworthyCondition("USED_GOOD"));
}

// ---------------------------------------------------------------------------

async function dbTests() {
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  if (!category) { ok("db skipped — no active category", true); return; }
  const before = { offer: await prisma.offer.count(), orderItem: await prisma.orderItem.count(), product: await prisma.product.count() };

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const S = await seedSeller(tx, `s9f22-${t}`);
      const ctx = ctxFor(S.id);
      const v = await seedVariant(tx, category.id);

      // 1 — OPEN_BOX accepted for 3P create
      const created = await createSellerOffer(ctx, { variantId: v.variantId, price: 4500, condition: "OPEN_BOX", openingQuantity: 5 }, tx);
      ok("1 · createSellerOffer accepts OPEN_BOX", created.ok === true, JSON.stringify(created));
      const offerId = created.ok ? created.offerId : "";
      const row0 = await tx.offer.findUnique({ where: { id: offerId }, select: { condition: true, status: true } });
      ok("1 · stored condition = OPEN_BOX, status DRAFT", row0?.condition === "OPEN_BOX" && row0?.status === "DRAFT");

      // 3 — invalid condition rejected
      const badCreate = await createSellerOffer(ctx, { variantId: v.variantId, price: 100, condition: "MINT" as never }, tx);
      ok("3 · createSellerOffer rejects an unknown condition", badCreate.ok === false);
      const badEdit = await updateSellerOffer(ctx, offerId, { condition: "MINT" as never }, tx);
      ok("3 · updateSellerOffer rejects an unknown condition", badEdit.ok === false);

      // 5 — DRAFT: condition may change
      const draftEdit = await updateSellerOffer(ctx, offerId, { condition: "REFURBISHED" }, tx);
      ok("5 · DRAFT offer condition change → ok", draftEdit.ok === true, JSON.stringify(draftEdit));
      ok("5 · same offer id, condition now REFURBISHED (no replacement offer)", (await tx.offer.findUnique({ where: { id: offerId }, select: { condition: true } }))?.condition === "REFURBISHED" && (await tx.offer.count({ where: { variantId: v.variantId, sellerId: S.id } })) === 1);

      // 6 — INACTIVE: condition may change. (The live marketplace.multiSellerCheckout
      // flag is already "true" from the 9F-9 pilot — read by setSellerOfferStatus
      // via the module client, so ACTIVE transitions are reachable here.)
      await setSellerOfferStatus(ctx, offerId, "INACTIVE", tx);
      const inactiveEdit = await updateSellerOffer(ctx, offerId, { condition: "OPEN_BOX" }, tx);
      ok("6 · INACTIVE offer condition change → ok", inactiveEdit.ok === true, JSON.stringify(inactiveEdit));

      // 4 — ACTIVE: condition CANNOT change
      const goLive = await setSellerOfferStatus(ctx, offerId, "ACTIVE", tx);
      ok("4 · precondition — offer is ACTIVE", goLive.ok === true, JSON.stringify(goLive));
      const activeEdit = await updateSellerOffer(ctx, offerId, { condition: "USED_GOOD" }, tx);
      ok("4 · ACTIVE offer condition change → REJECTED (VALIDATION)", activeEdit.ok === false && activeEdit.code === "VALIDATION", JSON.stringify(activeEdit));
      ok("4 · ACTIVE offer condition is UNCHANGED after the rejected attempt", (await tx.offer.findUnique({ where: { id: offerId }, select: { condition: true } }))?.condition === "OPEN_BOX");
      // non-condition edits on an ACTIVE offer still work
      ok("4 · ACTIVE offer price edit still works", (await updateSellerOffer(ctx, offerId, { price: 4700 }, tx)).ok === true);
      // passing the SAME condition on an ACTIVE offer is a no-op, not a rejection
      ok("4 · ACTIVE offer edit with the SAME condition → ok (no-op)", (await updateSellerOffer(ctx, offerId, { condition: "OPEN_BOX", price: 4800 }, tx)).ok === true);

      // 7 — uniqueness collision still works
      await setSellerOfferStatus(ctx, offerId, "INACTIVE", tx);
      const second = await createSellerOffer(ctx, { variantId: v.variantId, price: 5200, condition: "USED_GOOD" }, tx);
      ok("7 · a second offer for the same variant at a DIFFERENT condition → ok", second.ok === true);
      const collide = await updateSellerOffer(ctx, offerId, { condition: "USED_GOOD" }, tx);
      ok("7 · changing to a condition the seller already lists → CONFLICT", collide.ok === false && collide.code === "CONFLICT", JSON.stringify(collide));
      const dupeCreate = await createSellerOffer(ctx, { variantId: v.variantId, price: 1, condition: "OPEN_BOX" }, tx);
      ok("7 · re-creating the same (seller,variant,condition) → CONFLICT", dupeCreate.ok === false && dupeCreate.code === "CONFLICT");

      // 8 — 1P remains NEW
      const fp = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
      if (fp) {
        const fpOffers = await tx.offer.groupBy({ by: ["condition"], where: { sellerId: fp.id }, _count: true });
        ok("8 · every FIRST_PARTY offer is condition NEW", fpOffers.every((g) => g.condition === "NEW"), JSON.stringify(fpOffers));
      } else ok("8 · (no FIRST_PARTY seller in this DB — skipped)", true);

      // 9/10/11 — OrderItem snapshot + display gating
      const order = await tx.order.create({
        data: { orderNumber: `AX-T9F22-${t}`, email: `c-${t}@t.test`, phone: "+639999999999", status: "PROCESSING", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: 9000, shippingFee: 0, discountTotal: 0, grandTotal: 9000, shippingAddress: "{}" },
        select: { id: true, orderNumber: true },
      });
      const oiNew = await tx.orderItem.create({ data: { orderId: order.id, productId: v.productId, variantId: v.variantId, name: "New Item", unitPrice: 4500, quantity: 1, lineTotal: 4500, condition: "NEW" }, select: { condition: true } });
      const oiRef = await tx.orderItem.create({ data: { orderId: order.id, productId: v.productId, variantId: v.variantId, name: "Refurb Item", unitPrice: 4500, quantity: 1, lineTotal: 4500, condition: "REFURBISHED" }, select: { condition: true } });
      ok("9 · OrderItem.condition column persists a faithful snapshot (incl. NEW)", oiNew.condition === "NEW" && oiRef.condition === "REFURBISHED");
      ok("10 · a NEW order item shows NO condition line", !isNoteworthyCondition(oiNew.condition));
      ok("11 · a non-NEW order item shows 'Condition: Refurbished'", isNoteworthyCondition(oiRef.condition) && conditionLabel(oiRef.condition!) === "Refurbished");

      // seed-rbac guard — untouched (belt & braces vs an accidental store-setting leak)
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }

  ok("rollback · no offers leaked", (await prisma.offer.count()) === before.offer);
  ok("rollback · no order items leaked", (await prisma.orderItem.count()) === before.orderItem);
  ok("rollback · no products leaked", (await prisma.product.count()) === before.product);
}

function emailRenderTests() {
  console.log("\n── email render — seller_order_received ──");
  const base = {
    brand: "Axiaro", siteUrl: "https://axiaro.shop", sellerName: "Style Avenue",
    orderNumber: "AX-1", ordersUrl: "u", orderUrl: "u",
    merchandiseSubtotal: 9000, discountAllocated: 0, shippingFee: 0, payoutBasis: 9000,
    paymentMethodLabel: "Cash on Delivery (COD)", shipTo: null,
  };
  const withNonNew = renderSellerOrderReceived({
    ...base,
    items: [{ name: "Shirt", variantLabel: "M · Condition: Refurbished", quantity: 1, unitPrice: 9000, lineTotal: 9000 }],
  });
  ok("12 · non-NEW item → email carries 'Condition: Refurbished'", withNonNew.html.includes("Condition: Refurbished") && String(withNonNew.text).includes("Condition: Refurbished"));

  const newOnly = renderSellerOrderReceived({
    ...base,
    items: [{ name: "Shirt", variantLabel: "M", quantity: 1, unitPrice: 9000, lineTotal: 9000 }],
  });
  ok("13 · NEW-only item → email has NO 'Condition:' line (byte-identical shape)", !/Condition:/.test(newOnly.html) && !/Condition:/.test(String(newOnly.text)));

  // seller_order_cancelled unrelated to condition — unchanged
  const cancelled = renderSellerOrderCancelled({ brand: "Axiaro", siteUrl: "u", sellerName: "S", orderNumber: "AX-2", ordersUrl: "u" });
  ok("· seller_order_cancelled render still works (no condition coupling)", cancelled.subject === "Order AX-2 was cancelled");
}

async function main() {
  console.log("\nPHASE 9F-22 — product condition / status\n");
  staticTests();
  emailRenderTests();
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
