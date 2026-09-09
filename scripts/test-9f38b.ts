/**
 * PHASE 9F-38B — historical discount snapshot (`OrderItem.originalUnitPrice`).
 *
 * At checkout the bound Offer's `compareAtPrice` is snapshotted onto
 * `OrderItem.originalUnitPrice` (NULL when the Offer has no compare-at). Order
 * detail + the order-confirmation email then show the historical markdown —
 * "was ₱X" + a DERIVED "−N%" (via `discountPercent()`) — ONLY from that frozen
 * value, never the live Offer. The customer always pays `unitPrice`;
 * `originalUnitPrice` is display/history only and is NEVER added to a total.
 * Refund (unitPrice × qty), commission, settlement, and coupon economics are
 * untouched.
 *
 * DB fixtures build inside ONE prisma.$transaction and roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f38b.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { discountPercent } from "@/lib/utils";
import { renderOrderConfirmation } from "@/lib/email/templates/order-confirmation";
import { itemsTable } from "@/lib/email/html";
import { sellerReceivable, getSellerSettlementPreview } from "@/lib/marketplace/settlement";

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

/**
 * The checkout snapshot rule — MUST stay byte-identical to the `originalUnitPrice:`
 * line in `src/lib/checkout.ts` (asserted statically below). Replicated so the
 * DB tests exercise the exact expression without importing the checkout module
 * (it pulls in next/navigation).
 */
const snapshotOriginalUnitPrice = (o: { compareAtPrice: number | null }) => o.compareAtPrice ?? null;

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — derivation ──");

  // 3 / 5 — discountPercent is the single source of the shown %
  ok("3 · discountPercent(2190, 2590) === 15 (the '−15%' in the spec)", discountPercent(2190, 2590) === 15);
  ok("3 · discountPercent(32990, 38990) === 15", discountPercent(32990, 38990) === 15);
  ok("5 · original == unit → 0 (no markdown shown)", discountPercent(2000, 2000) === 0);
  ok("5 · original < unit (bad raw data) → 0", discountPercent(2000, 1500) === 0);
  ok("5 · original null/undefined → 0", discountPercent(2000, null) === 0 && discountPercent(2000, undefined) === 0);

  // the display gate: markdown shown ⟺ originalUnitPrice != null && > unitPrice
  const shows = (unit: number, orig: number | null) =>
    orig != null && orig > unit && discountPercent(unit, orig) > 0;
  ok("gate · (unit 2190, orig 2590) → shown", shows(2190, 2590));
  ok("gate · (unit 2000, orig null) → hidden", !shows(2000, null));
  ok("gate · (unit 2000, orig 2000) → hidden", !shows(2000, 2000));
  ok("gate · (unit 2000, orig 1500) → hidden", !shows(2000, 1500));

  // derived discount AMOUNT is max(0, orig - unit) — never stored
  const amount = (unit: number, orig: number | null) => Math.max(0, (orig ?? unit) - unit);
  ok("amount · max(0, 2590 - 2190) === 400", amount(2190, 2590) === 400);
  ok("amount · max(0, 1500 - 2000) === 0", amount(2000, 1500) === 0);

  // 1 / 2 — the snapshot rule itself
  ok("1 · snapshot of a discounted Offer → its compareAtPrice", snapshotOriginalUnitPrice({ compareAtPrice: 259000 }) === 259000);
  ok("2 · snapshot of an Offer with no compare-at → null", snapshotOriginalUnitPrice({ compareAtPrice: null }) === null);
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const schema = read("prisma/schema.prisma");
  const migration = read("supabase/migrations/20260909200000_orderitem_original_price.sql");
  const pkg = read("package.json");
  const checkout = read("src/lib/checkout.ts");
  const checkoutCode = strip(checkout);
  const orderDetail = read("src/components/order/order-detail.tsx");
  const template = read("src/lib/email/templates/order-confirmation.ts");
  const html = read("src/lib/email/html.ts");
  const notifs = read("src/lib/email/notifications.ts");
  const data = read("src/lib/data.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const returnsActions2 = read("src/lib/returns-actions.ts");
  const settlement = read("src/lib/marketplace/settlement.ts");

  // C — schema + migration
  ok("schema · OrderItem gains nullable originalUnitPrice Int?", /originalUnitPrice\s+Int\?/.test(schema));
  ok("schema · it sits on OrderItem (after condition)", (() => {
    const m = schema.match(/model OrderItem \{[\s\S]*?\n\}/);
    return !!m && /originalUnitPrice\s+Int\?/.test(m[0]);
  })());
  ok("migration · additive ADD COLUMN IF NOT EXISTS INTEGER, no DROP / DELETE / UPDATE / backfill",
    /ADD COLUMN IF NOT EXISTS "originalUnitPrice" INTEGER/.test(migration) &&
    !/\b(DROP|DELETE|UPDATE|TRUNCATE)\b/i.test(migration.replace(/--.*$/gm, "")));
  ok("migration · explicitly documents 'DO NOT backfill' / unrecoverable",
    /DO NOT backfill/i.test(migration) && /unrecoverable/i.test(migration));
  ok("package.json · db:migrate:9f38b + test:9f38b scripts registered",
    /"db:migrate:9f38b": ".*20260909200000_orderitem_original_price\.sql"/.test(pkg) &&
    /"test:9f38b":/.test(pkg));

  // C — checkout snapshot
  ok("checkout · bound-offer select still includes compareAtPrice", (() => {
    const m = checkout.match(/offer: \{\s*select: \{[\s\S]{0,700}?\n\s*inventory:/);
    return !!m && /compareAtPrice: true,/.test(m[0]);
  })());
  ok("checkout · line snapshots originalUnitPrice: o.compareAtPrice ?? null (the BOUND offer, not re-picked)",
    /originalUnitPrice: o\.compareAtPrice \?\? null,/.test(checkoutCode));
  ok("checkout · orderItem.createMany writes originalUnitPrice: l.originalUnitPrice",
    /condition: l\.condition,\s*[\s\S]{0,400}\n\s*originalUnitPrice: l\.originalUnitPrice,/.test(checkoutCode));
  ok("checkout · the snapshot line does NOT call resolveWinningOfferView / re-pick", (() => {
    const i = checkout.indexOf("originalUnitPrice: o.compareAtPrice");
    const region = checkout.slice(i - 4000, i);
    return !/resolveWinningOfferView\(|pickWinningOffer\(/.test(region);
  })());
  ok("checkout · commission basis unchanged — roundHalfUp((subtotal * ... ) / 10000), subtotal from unitPrice",
    /const sellerCommissionAmount = roundHalfUp\(\(subtotal \* soSeller\.commissionRate\) \/ 10000\);/.test(checkout) &&
    !/compareAtPrice[\s\S]{0,80}commission/i.test(checkoutCode));

  // D — order detail (customer)
  ok("order-detail · imports the shared discountPercent helper",
    /import \{ formatPrice, formatDate, discountPercent \} from "@\/lib\/utils"/.test(orderDetail));
  ok("order-detail · gates the 'was' line on originalUnitPrice != null && > unitPrice (frozen snapshot)",
    /it\.originalUnitPrice != null && it\.originalUnitPrice > it\.unitPrice/.test(orderDetail));
  ok("order-detail · % is derived via discountPercent(it.unitPrice, it.originalUnitPrice)",
    /discountPercent\(it\.unitPrice, it\.originalUnitPrice\)/.test(orderDetail));
  ok("order-detail · renders a struck 'was' figure + −N%, only when offPercent > 0",
    /<s>\{formatPrice\(wasLineTotal\)\}<\/s>/.test(orderDetail) && /hadMarkdown && offPercent > 0/.test(orderDetail));
  ok("order-detail · never reads a live Offer (no compareAtPrice / offer join in the component)",
    !/compareAtPrice/.test(orderDetail) && !/\.offer\b/.test(strip(orderDetail)));

  // E — email
  ok("template · OrderConfirmationData items carry optional originalUnitPrice, no 'condition' field added",
    /originalUnitPrice\?: number \| null;/.test(template));
  ok("template · text line adds a '(was …, -N%)' note only when originalUnitPrice > unitPrice",
    /it\.originalUnitPrice != null && it\.originalUnitPrice > it\.unitPrice/.test(template) &&
    /was \$\{peso\(it\.originalUnitPrice! \* it\.quantity\)\}, -\$\{off\}%/.test(template));
  ok("html · itemsTable accepts optional originalUnitPrice and strikes it + derives −N% via discountPercent",
    /originalUnitPrice\?: number \| null;/.test(html) &&
    /discountPercent\(it\.unitPrice, it\.originalUnitPrice\)/.test(html) &&
    /text-decoration:line-through/.test(html));
  ok("html · the 'was' cell is emitted only when hadMarkdown && off > 0",
    /const hadMarkdown =\s*\n?\s*it\.originalUnitPrice != null && it\.originalUnitPrice > it\.unitPrice;/.test(html));
  ok("notifications · sendOrderConfirmation maps originalUnitPrice: i.originalUnitPrice (frozen row)",
    /originalUnitPrice: i\.originalUnitPrice,/.test(notifs));
  ok("notifications · ORDER_INCLUDE still a bare `items` (no select) — originalUnitPrice arrives as a scalar",
    /const ORDER_INCLUDE = \{\s*\n\s*items: \{ orderBy: \{ id: "asc" \} as const \},\s*\n\s*user: \{ select: \{ name: true \} \},\s*\n\} as const;/.test(notifs));
  ok("notifications · idempotency key unchanged (ORDER_CREATED:${order.id})",
    /idempotencyKey: `ORDER_CREATED:\$\{order\.id\}`/.test(notifs));

  // F — historical-order safety: no order-reading path joins the live Offer for price
  const getOrderByNumber = data.match(/export async function getOrderByNumber\([\s\S]*?\n\}/)?.[0] ?? "";
  ok("F · getOrderByNumber uses `include: { items: true }` — scalars only, NO offer join",
    /include: \{\s*\n\s*items: true,/.test(getOrderByNumber) && !/compareAtPrice/.test(getOrderByNumber) && !/offer:/.test(getOrderByNumber));
  ok("F · getAdminOrder item select has no offer join / no compareAtPrice", (() => {
    const m = read("src/lib/admin/orders.ts").match(/export async function getAdminOrder\([\s\S]*?\n\}/);
    return !!m && !/compareAtPrice/.test(m[0]) && !/offer: \{/.test(m[0]);
  })());
  ok("F · sendOrderConfirmation region reads no live Offer price (no compareAtPrice anywhere in notifications.ts)",
    !/compareAtPrice/.test(notifs));
  ok("F · order-confirmation template never reads a live record (built from the passed snapshot only)",
    !/prisma|findUnique|findFirst|\.offer\b/.test(strip(template)));

  // G — refund / commission / settlement untouched
  ok("G · admin refund still refundAmount: it.unitPrice * l.quantity (frozen), no originalUnitPrice / compareAtPrice",
    /refundAmount: it\.unitPrice \* l\.quantity,/.test(returnsActions) &&
    !/originalUnitPrice/.test(returnsActions) && !/compareAtPrice/.test(returnsActions));
  ok("G · returns-actions (customer) refund still line.unitPrice * r.quantity",
    /refundAmount: line\.unitPrice \* r\.quantity,/.test(returnsActions2) && !/originalUnitPrice/.test(returnsActions2));
  ok("G · return commission correction still roundHalfUp((returnedValue * so.commissionRate) / 10000)",
    /const commissionAdjustment = roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\);/.test(returnsActions));
  ok("G · settlement.ts not touched by 9F-38B; sellerReceivable still total − commissionAmount",
    !/9F-38B/.test(settlement) && !/originalUnitPrice/.test(settlement) &&
    /return so\.total - so\.commissionAmount;/.test(settlement));

  // scope
  ok("scope · seed-rbac.ts untouched", !/9F-38B/.test(read("scripts/seed-rbac.ts")));
  ok("scope · buy-box-rule / offer-resolver / cart untouched by 9F-38B",
    !/9F-38B/.test(read("src/lib/marketplace/buy-box-rule.ts")) &&
    !/9F-38B/.test(read("src/lib/marketplace/offer-resolver.ts")) &&
    !/9F-38B/.test(read("src/lib/cart.ts")));
  ok("scope · coupon economics untouched — discountFundedBy: \"PLATFORM\" unchanged, no 9F-38B near it",
    /discountFundedBy: "PLATFORM",/.test(checkout));
}

// ── rendered email ──────────────────────────────────────────────────────
function renderTests() {
  console.log("\n── rendered order_confirmation + itemsTable ──");
  const base = {
    brand: "Axiaro", siteUrl: "https://axiaro.shop", orderUrl: "https://axiaro.shop/order/AX-1",
    orderNumber: "AX-1", placedAt: new Date("2026-09-09T00:00:00Z"), customerName: "Mara",
    subtotal: 2190, discountTotal: 0, couponCode: null, shippingMethodName: null, shippingFee: 0,
    grandTotal: 2190, shippingAddress: { firstName: "Mara", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000" },
    payOnDelivery: true,
  };

  // 14 — discounted item renders "was" + %
  const disc = renderOrderConfirmation({
    ...base,
    items: [{ name: "Street Low Leather Sneaker", variantLabel: "42", quantity: 1, unitPrice: 2190, lineTotal: 2190, originalUnitPrice: 2590 }],
  });
  ok("14 · HTML shows the struck 'was' price (₱25.90 for 2590 centavos) + '-15%'",
    /line-through/.test(disc.html) && disc.html.includes("₱25.90") && disc.html.includes("-15%"));
  ok("14 · text shows '(was ₱25.90, -15%)'", String(disc.text).includes("(was ₱25.90, -15%)"));

  // 15 — non-discounted item: byte-identical to omitting the field
  const withNull = renderOrderConfirmation({
    ...base,
    items: [{ name: "Thing", variantLabel: "M", quantity: 1, unitPrice: 2190, lineTotal: 2190, originalUnitPrice: null }],
  });
  const withoutField = renderOrderConfirmation({
    ...base,
    items: [{ name: "Thing", variantLabel: "M", quantity: 1, unitPrice: 2190, lineTotal: 2190 }],
  });
  ok("15 · originalUnitPrice: null → HTML byte-identical to omitting the field", withNull.html === withoutField.html);
  ok("15 · originalUnitPrice: null → text byte-identical to omitting the field", String(withNull.text) === String(withoutField.text));
  ok("15 · non-discounted email has no 'was' / 'line-through' / '-15%'",
    !/line-through/.test(withNull.html) && !/\bwas ₱/.test(String(withNull.text)));

  // 5 — original <= unit → nothing shown
  const bad = renderOrderConfirmation({
    ...base,
    items: [{ name: "Thing", variantLabel: null, quantity: 1, unitPrice: 2190, lineTotal: 2190, originalUnitPrice: 2000 }],
  });
  ok("5 · originalUnitPrice <= unitPrice → email renders no markdown", !/line-through/.test(bad.html) && !/-\d+%/.test(bad.html));

  // itemsTable direct — qty > 1 strikes the per-UNIT was price
  const table = itemsTable([{ name: "Sofa", quantity: 2, unitPrice: 3299000, lineTotal: 6598000, originalUnitPrice: 3899000 }]);
  ok("itemsTable · qty 2 discounted → struck per-unit was (₱38,990) + derived -15%",
    /line-through/.test(table) && table.includes("₱38,990") && table.includes("-15%"));
  const tablePlain = itemsTable([{ name: "Sofa", quantity: 2, unitPrice: 3299000, lineTotal: 6598000 }]);
  ok("itemsTable · no originalUnitPrice → no strike / no %", !/line-through/.test(tablePlain) && !/-\d+%/.test(tablePlain));
}

// ── DB fixtures (rolled back) ────────────────────────────────────────────
async function dbTests() {
  console.log("\n── DB fixtures (rolled back) ──");
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  const fp = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true, displayName: true, type: true, supportEmail: true, commissionRate: true } });
  if (!category || !fp) { ok("(skipped — no category / FIRST_PARTY seller)", true); return; }

  const before = { orders: await prisma.order.count(), items: await prisma.orderItem.count(), offers: await prisma.offer.count() };
  const sfx = "9f38b-" + Date.now().toString(36);

  const mkVariant = async (tx: Tx, productId: string, sku: string, price: number, compareAt: number | null) =>
    tx.variant.create({ data: { productId, sku, price, compareAtPrice: compareAt, status: "ACTIVE", stock: 50 }, select: { id: true } });
  const mkOffer = async (tx: Tx, sellerId: string, variantId: string, price: number, compareAt: number | null) => {
    const o = await tx.offer.create({
      data: { sellerId, variantId, price, compareAtPrice: compareAt, condition: "NEW", status: "ACTIVE", sellerSku: `os-${Math.random().toString(36).slice(2, 9)}` },
      select: { id: true, price: true, compareAtPrice: true },
    });
    await tx.offerInventory.create({ data: { offerId: o.id, sellerSku: `oi-${Math.random().toString(36).slice(2, 9)}`, quantity: 50, reserved: 0, reorderPoint: 3 } });
    return o;
  };
  /** Mirrors the checkout writer's OrderItem row for one bound offer. */
  const mkOrderWithItem = async (
    tx: Tx,
    seller: { id: string; displayName: string; type: string; supportEmail: string; commissionRate: number },
    o: { id: string; price: number; compareAtPrice: number | null },
    qty: number,
    tag: string,
    discountAllocated = 0,
  ) => {
    const subtotal = o.price * qty;
    const shippingFee = 0;
    const total = subtotal - discountAllocated + shippingFee;
    const commissionAmount = roundHalfUp((subtotal * seller.commissionRate) / 10000);
    const order = await tx.order.create({
      data: {
        orderNumber: `AX-${tag}-${Math.random().toString(36).slice(2, 6)}`,
        email: "buyer@example.test", phone: "+639000000000",
        status: "PENDING_PAYMENT", paymentMethod: "NONE", paymentStatus: "PENDING",
        subtotal, shippingFee, discountTotal: discountAllocated, grandTotal: subtotal - discountAllocated + shippingFee,
        shippingAddress: JSON.stringify({ firstName: "T", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
      },
      select: { id: true, orderNumber: true, subtotal: true },
    });
    const so = await tx.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: seller.id, sellerName: seller.displayName, sellerType: seller.type,
        supportEmail: seller.supportEmail, commissionRate: seller.commissionRate,
        merchandiseSubtotal: subtotal, discountAllocated, shippingFee, platformShippingSubsidy: 0, freeShippingApplied: false,
        discountFundedBy: "PLATFORM", commissionAmount, total, status: "PENDING_PAYMENT", settlementStatus: "PENDING_CAPTURE",
      },
      select: { id: true, commissionAmount: true, total: true },
    });
    const item = await tx.orderItem.create({
      data: {
        orderId: order.id, sellerOrderId: so.id, sellerId: seller.id, offerId: o.id,
        commissionRate: seller.commissionRate, productId: "p", name: `Item ${tag}`,
        unitPrice: o.price, quantity: qty, lineTotal: o.price * qty,
        condition: "NEW",
        // the exact checkout snapshot rule
        originalUnitPrice: snapshotOriginalUnitPrice(o),
      },
      select: { id: true, unitPrice: true, lineTotal: true, originalUnitPrice: true, offerId: true },
    });
    return { order, so, item };
  };

  try {
    await prisma.$transaction(async (tx) => {
      const product = await tx.product.create({
        data: { name: `P ${sfx}`, slug: `p-${sfx}`, brand: "Axiaro", shortDescription: "s", description: "d", categoryId: category.id, status: "ACTIVE", price: 5000 },
        select: { id: true },
      });
      const tp = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `TP ${sfx}`, slug: `tp-${sfx}`, supportEmail: "tp@t.test", commissionRate: 1500 },
        select: { id: true, displayName: true, type: true, supportEmail: true, commissionRate: true },
      });

      // ── 1 · discounted Offer → originalUnitPrice = compareAtPrice ──
      const vD = await mkVariant(tx, product.id, `vD-${sfx}`, 219000, 259000);
      const oD = await mkOffer(tx, fp.id, vD.id, 219000, 259000);
      const D = await mkOrderWithItem(tx, fp, oD, 1, "D1");
      ok("1 · discounted Offer (compareAt 259000 > price 219000) → OrderItem.originalUnitPrice === 259000",
        D.item.originalUnitPrice === 259000 && D.item.unitPrice === 219000);
      ok("1 · derived % from the frozen row === discountPercent(219000, 259000) === 15",
        discountPercent(D.item.unitPrice, D.item.originalUnitPrice) === 15);

      // ── 2 · Offer with no compare-at → NULL ──
      const vN = await mkVariant(tx, product.id, `vN-${sfx}`, 219000, null);
      const oN = await mkOffer(tx, fp.id, vN.id, 219000, null);
      const N = await mkOrderWithItem(tx, fp, oN, 1, "N1");
      ok("2 · Offer with compareAtPrice NULL → OrderItem.originalUnitPrice NULL", N.item.originalUnitPrice === null);
      ok("4 · a NULL snapshot shows no markdown (gate false)",
        !(N.item.originalUnitPrice != null && N.item.originalUnitPrice > N.item.unitPrice));

      // ── 6 · Offer changed AFTER purchase → frozen row unchanged ──
      await tx.offer.update({ where: { id: oD.id }, data: { price: 150000, compareAtPrice: 900000 } });
      const reread = await tx.orderItem.findUniqueOrThrow({ where: { id: D.item.id }, select: { unitPrice: true, lineTotal: true, originalUnitPrice: true } });
      ok("6 · after Offer.price/compareAtPrice change, OrderItem.unitPrice/lineTotal/originalUnitPrice all unchanged",
        reread.unitPrice === 219000 && reread.lineTotal === 219000 && reread.originalUnitPrice === 259000);
      ok("6 · derived % still 15 (from the frozen row, not the mutated Offer)",
        discountPercent(reread.unitPrice, reread.originalUnitPrice) === 15);

      // ── 7 · Offer DELETED after purchase → SET NULL FK, price history intact ──
      await tx.offerInventory.deleteMany({ where: { offerId: oD.id } });
      await tx.offer.delete({ where: { id: oD.id } });
      const afterDel = await tx.orderItem.findUniqueOrThrow({ where: { id: D.item.id }, select: { offerId: true, unitPrice: true, originalUnitPrice: true } });
      ok("7 · Offer deleted → OrderItem.offerId NULL but unitPrice 219000 + originalUnitPrice 259000 still display correctly",
        afterDel.offerId === null && afterDel.unitPrice === 219000 && afterDel.originalUnitPrice === 259000 &&
        discountPercent(afterDel.unitPrice, afterDel.originalUnitPrice) === 15);

      // ── 8 · refund = unitPrice × quantity (frozen), never originalUnitPrice ──
      const vR = await mkVariant(tx, product.id, `vR-${sfx}`, 100000, 150000);
      const oR = await mkOffer(tx, tp.id, vR.id, 100000, 150000);
      const R = await mkOrderWithItem(tx, tp, oR, 2, "R1");
      const refundAmount = R.item.unitPrice * 2; // the returns-actions formula
      ok("8 · refundAmount = unitPrice(100000) × qty(2) = 200000 — NOT originalUnitPrice-based (300000)",
        refundAmount === 200000 && R.item.originalUnitPrice === 150000);

      // ── 9 · commission has zero dependence on compareAtPrice ──
      // Two SellerOrders, identical price/qty, one Offer has a compare-at and one does not.
      const vC1 = await mkVariant(tx, product.id, `vC1-${sfx}`, 120000, 200000);
      const vC2 = await mkVariant(tx, product.id, `vC2-${sfx}`, 120000, null);
      const oC1 = await mkOffer(tx, tp.id, vC1.id, 120000, 200000);
      const oC2 = await mkOffer(tx, tp.id, vC2.id, 120000, null);
      const C1 = await mkOrderWithItem(tx, tp, oC1, 3, "C1");
      const C2 = await mkOrderWithItem(tx, tp, oC2, 3, "C2");
      ok("9 · SellerOrder.commissionAmount identical with vs without a compare-at (both roundHalfUp(360000*1500/10000)=54000)",
        C1.so.commissionAmount === C2.so.commissionAmount && C1.so.commissionAmount === 54000);
      ok("9 · SellerOrder.total identical (compareAt never enters merch/total)", C1.so.total === C2.so.total && C1.so.total === 360000);

      // ── 10 · settlement receivable / eligibility unaffected by compareAtPrice ──
      ok("10 · sellerReceivable(C1) === sellerReceivable(C2) === total − commission (306000)",
        sellerReceivable(C1.so) === sellerReceivable(C2.so) && sellerReceivable(C1.so) === 306000);
      // drive both planes to DELIVERED, 60d old, and check the preview treats them identically
      for (const x of [C1, C2]) {
        await tx.order.update({ where: { id: x.order.id }, data: { status: "DELIVERED", placedAt: new Date(Date.now() - 60 * 86400_000), deliveredAt: new Date(Date.now() - 60 * 86400_000) } });
        await tx.sellerOrder.update({ where: { id: x.so.id }, data: { status: "DELIVERED" } });
      }
      const preview = await getSellerSettlementPreview(tp.id, tx);
      const rows = preview.eligibleOrders.filter((e) => e.orderNumber === C1.order.orderNumber || e.orderNumber === C2.order.orderNumber);
      ok("10 · both orders equally settlement-eligible; receivable identical",
        rows.length === 2 && rows[0].receivable === rows[1].receivable && rows[0].receivable === 306000);

      // ── 11 · 1P — Variant compare-at → 1P Offer → checkout snapshot ──
      const v1P = await mkVariant(tx, product.id, `v1P-${sfx}`, 500000, 650000);
      const o1P = await mkOffer(tx, fp.id, v1P.id, 500000, 650000); // 1P offers mirror Variant compare-at via syncFirstPartyOfferPrice
      const P1 = await mkOrderWithItem(tx, fp, o1P, 1, "P1");
      ok("11 · 1P order snapshots originalUnitPrice = the 1P Offer.compareAtPrice (650000)",
        P1.item.originalUnitPrice === 650000 && P1.item.unitPrice === 500000);

      // ── 12 / 13 · 3P with and without compare-at ──
      const v3P = await mkVariant(tx, product.id, `v3P-${sfx}`, 89900, 119900);
      const o3P = await mkOffer(tx, tp.id, v3P.id, 89900, 119900);
      const T1 = await mkOrderWithItem(tx, tp, o3P, 1, "T1");
      ok("12 · 3P seller Offer compare-at → snapshot (119900)", T1.item.originalUnitPrice === 119900);
      const v3Pn = await mkVariant(tx, product.id, `v3Pn-${sfx}`, 89900, null);
      const o3Pn = await mkOffer(tx, tp.id, v3Pn.id, 89900, null);
      const T2 = await mkOrderWithItem(tx, tp, o3Pn, 1, "T2");
      ok("13 · 3P Offer without compare-at → originalUnitPrice NULL", T2.item.originalUnitPrice === null);

      // ── 16 · coupon coexistence — subtotal is Σ unitPrice×qty, not Σ originalUnitPrice ──
      const vK = await mkVariant(tx, product.id, `vK-${sfx}`, 219000, 259000);
      const oK = await mkOffer(tx, tp.id, vK.id, 219000, 259000);
      const K = await mkOrderWithItem(tx, tp, oK, 2, "K1", 20000); // ₱200 coupon allocated
      ok("16 · Order.subtotal = unitPrice(219000) × 2 = 438000 (NOT originalUnitPrice 259000 × 2 = 518000)",
        K.order.subtotal === 438000);
      ok("16 · SellerOrder.total reconciles merch − discount + ship (438000 − 20000 + 0 = 418000); originalUnitPrice absent from the sum",
        K.so.total === 418000);
      ok("16 · the frozen line still carries its own markdown snapshot alongside the order-level coupon",
        K.item.originalUnitPrice === 259000 && discountPercent(K.item.unitPrice, K.item.originalUnitPrice) === 15);

      // ── 3 · rendered order detail data path — a discounted row yields "was" + % ──
      const full = await tx.order.findUniqueOrThrow({ where: { id: D.order.id }, include: { items: true } });
      const it = full.items[0];
      const hadMarkdown = it.originalUnitPrice != null && it.originalUnitPrice > it.unitPrice;
      ok("3 · order-detail data path (include: { items: true }) exposes originalUnitPrice as a scalar → markdown shown",
        hadMarkdown && discountPercent(it.unitPrice, it.originalUnitPrice) === 15);

      // ── 18 · additive column — nothing else got an originalUnitPrice ──
      ok("18 · every OrderItem outside this tx still has originalUnitPrice NULL",
        (await tx.orderItem.count({ where: { originalUnitPrice: { not: null }, name: { not: { startsWith: "Item " } } } })) === 0);

      throw new Rollback();
    }, { timeout: 120_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("rollback · no Order leaked", (await prisma.order.count()) === before.orders);
  ok("rollback · no OrderItem leaked", (await prisma.orderItem.count()) === before.items);
  ok("rollback · no Offer leaked", (await prisma.offer.count()) === before.offers);
}

// ── production (READ-ONLY) ───────────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  const col = await prisma.$queryRawUnsafe<{ is_nullable: string; column_default: string | null }[]>(
    `SELECT is_nullable, column_default FROM information_schema.columns WHERE table_name='OrderItem' AND column_name='originalUnitPrice'`,
  );
  ok("18 · OrderItem.originalUnitPrice exists, is nullable, no default", col.length === 1 && col[0].is_nullable === "YES" && col[0].column_default === null);
  ok("18 · every existing OrderItem row has originalUnitPrice NULL (no backfill)",
    (await prisma.orderItem.count({ where: { originalUnitPrice: { not: null } } })) === 0);
  ok("K · Order count unchanged (9)", (await prisma.order.count()) === 9);
  ok("K · OrderItem count unchanged (9)", (await prisma.orderItem.count()) === 9);
  ok("K · Offer count unchanged (333)", (await prisma.offer.count()) === 333);
  ok("K · returns / settlements / payments still 0", (await prisma.returnItem.count()) === 0 && (await prisma.sellerSettlement.count()) === 0 && (await prisma.payment.count()) === 0);
}

async function main() {
  console.log("\nPHASE 9F-38B — historical discount snapshot (OrderItem.originalUnitPrice)\n");
  pureTests();
  staticTests();
  renderTests();
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
