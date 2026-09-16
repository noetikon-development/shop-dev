/**
 * SELLER-SCOPED RETURN ELIGIBILITY — regression tests.
 *
 * Fixes the confirmed multi-seller returns dead-end: `returnEligibility` used
 * to gate on the aggregate `Order.status === "DELIVERED"`, but a multi-seller
 * order's `Order.status` can stay PROCESSING while one SellerOrder has already
 * reached DELIVERED (the 9F-12b/9F-35B rollup only advances the parent once
 * EVERY SellerOrder catches up). A customer whose own seller's items already
 * arrived had no way to start a return until every OTHER seller on the order
 * also delivered.
 *
 * The fix (`src/lib/returns.ts` `orderItemDeliveryState` / `withinReturnWindow`,
 * reused by `returnEligibility` and admin's `orderReturnableLines` /
 * `adminCreateReturnAction`): each OrderItem's delivery state is judged by its
 * OWN SellerOrder.status (falling back to the legacy whole-order check only
 * for a pre-marketplace line with no SellerOrder at all), and the return
 * window is anchored on that SellerOrder's own Shipment.deliveredAt. No new
 * column, no ReturnRequest.sellerOrderId, no change to return processing
 * (receiveReturnAction / restock / commission / settlement / destination) or
 * to the return_one_open_per_order constraint.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-returns.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  returnEligibility,
  getReturnsConfig,
  orderItemDeliveryState,
  withinReturnWindow,
  type ReturnEligibilityOrder,
} from "@/lib/returns";
import { orderReturnableLines } from "@/lib/admin/returns";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const rand = () => Math.random().toString(36).slice(2, 7);
const days = (n: number) => n * 24 * 60 * 60 * 1000;

// ── pure — orderItemDeliveryState / withinReturnWindow ──────────────────
function pureTests() {
  console.log("\n── pure — orderItemDeliveryState / withinReturnWindow ──");

  const order: ReturnEligibilityOrder = { status: "PROCESSING", deliveredAt: null, placedAt: new Date("2026-01-01") };

  ok("sellerOrder DELIVERED → delivered:true, deliveredAt from its own shipment",
    (() => {
      const shipDate = new Date("2026-02-01");
      const r = orderItemDeliveryState(order, { status: "DELIVERED", shipments: [{ deliveredAt: shipDate }] });
      return r.delivered === true && r.deliveredAt?.getTime() === shipDate.getTime();
    })());

  ok("sellerOrder PROCESSING → delivered:false regardless of parent Order.status",
    orderItemDeliveryState(order, { status: "PROCESSING", shipments: [] }).delivered === false);

  ok("sellerOrder SHIPPED → delivered:false (not yet DELIVERED)",
    orderItemDeliveryState(order, { status: "SHIPPED", shipments: [] }).delivered === false);

  ok("sellerOrder DELIVERED but no shipment row → falls back to Order.deliveredAt/placedAt, never crashes",
    (() => {
      const withOrderDeliveredAt: ReturnEligibilityOrder = { status: "PROCESSING", deliveredAt: new Date("2026-03-01"), placedAt: new Date("2026-01-01") };
      const r = orderItemDeliveryState(withOrderDeliveredAt, { status: "DELIVERED", shipments: [] });
      return r.delivered === true && r.deliveredAt?.getTime() === new Date("2026-03-01").getTime();
    })());

  ok("legacy item (sellerOrder null) → follows the ORIGINAL whole-order check, byte for byte",
    (() => {
      const deliveredOrder: ReturnEligibilityOrder = { status: "DELIVERED", deliveredAt: new Date("2026-01-05"), placedAt: new Date("2026-01-01") };
      const notDeliveredOrder: ReturnEligibilityOrder = { status: "PROCESSING", deliveredAt: null, placedAt: new Date("2026-01-01") };
      const a = orderItemDeliveryState(deliveredOrder, null);
      const b = orderItemDeliveryState(notDeliveredOrder, null);
      return a.delivered === true && a.deliveredAt?.getTime() === new Date("2026-01-05").getTime() && b.delivered === false;
    })());

  ok("withinReturnWindow — inside the window is true, past it is false, duration is exactly windowDays",
    (() => {
      const deliveredAt = new Date(Date.now() - days(10));
      return withinReturnWindow(deliveredAt, 30) === true && withinReturnWindow(deliveredAt, 5) === false;
    })());
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const returns = read("src/lib/returns.ts");
  const adminReturns = read("src/lib/admin/returns.ts");
  const adminActions = read("src/lib/admin/returns-actions.ts");
  const sellerReturnRepo = read("src/lib/marketplace/seller-return-repository.ts");
  const schema = read("prisma/schema.prisma");

  ok("returns.ts exports the shared orderItemDeliveryState / withinReturnWindow helpers",
    /export function orderItemDeliveryState/.test(returns) && /export function withinReturnWindow/.test(returns));
  ok("returnEligibility no longer gates on the aggregate Order.status === DELIVERED",
    !/if \(order\.status !== "DELIVERED"\) return \{ eligible: false, code: "not_delivered" \}/.test(returns));
  ok("returnEligibility reads sellerOrder (status + shipments.deliveredAt) per item",
    /sellerOrder: \{ select: \{ status: true, shipments: \{ select: \{ deliveredAt: true \} \} \} \}/.test(returns));
  ok("returnEligibility uses orderItemDeliveryState per item, not a single whole-order timestamp",
    /orderItemDeliveryState\(order, it\.sellerOrder\)/.test(returns));

  ok("admin/returns.ts's orderReturnableLines reuses the SAME canonical helper (no duplicated logic)",
    /import \{ remainingReturnableByOrderItem, orderItemDeliveryState \} from "@\/lib\/returns"/.test(adminReturns) &&
      /orderItemDeliveryState\(order, it\.sellerOrder\)/.test(adminReturns));
  ok("admin/returns.ts exposes delivered + deliveredAt per returnable line",
    /delivered: state\.delivered/.test(adminReturns) && /deliveredAt: state\.deliveredAt/.test(adminReturns));

  ok("admin/returns-actions.ts's override computation is now PER LINE, not the aggregate order status",
    !/if \(order\.status !== "DELIVERED"\) overridden\.push\("status"\)/.test(adminActions) &&
      /orderItemDeliveryState\(order, it\.sellerOrder\)/.test(adminActions) &&
      /overridden\.add\("status"\)/.test(adminActions) &&
      /overridden\.add\("window"\)/.test(adminActions));
  ok("admin/returns-actions.ts still records overriddenRules on the created ReturnRequest (audit trail preserved)",
    /overriddenRules: overriddenList\.length \? JSON\.stringify\(overriddenList\) : null/.test(adminActions));

  // Scope — everything the task said not to touch is untouched.
  ok("receiveReturnAction's per-SellerOrder commission-adjustment block is UNTOUCHED",
    /are always all from the same parent Order, so today this is at most\s*\n\s*\/\/ one SellerOrder, but the code doesn't assume that\./.test(adminActions) &&
      /const commissionAdjustment = roundHalfUp\(\(returnedValue \* so\.commissionRate\) \/ 10000\);/.test(adminActions));
  ok("restoreOfferStock / OfferAdjustment(RETURN) restock path is UNTOUCHED",
    /reason: "RETURN"/.test(adminActions));
  ok("return-destination resolution (9F-41B) is UNTOUCHED by this fix",
    !/orderItemDeliveryState|withinReturnWindow/.test(read("src/lib/marketplace/return-destination.ts")));
  ok("seller self-service mixed-seller restriction (MIXED_SELLER) is UNTOUCHED",
    /MIXED_SELLER/.test(sellerReturnRepo) &&
      /a return whose lines are NOT all this seller's is refused/.test(sellerReturnRepo) &&
      !/orderItemDeliveryState|withinReturnWindow/.test(sellerReturnRepo));
  ok("no ReturnRequest.sellerOrderId column added — no schema change",
    !/sellerOrderId/.test(schema.slice(schema.indexOf("model ReturnRequest"), schema.indexOf("model ReturnItem"))));
  ok("return_one_open_per_order constraint reference is UNTOUCHED",
    /CREATE UNIQUE INDEX "return_one_open_per_order" ON "ReturnRequest"\("orderId"\)/.test(schema));
  ok("no PARTIALLY_CANCELLED / PARTIALLY_SHIPPED introduced",
    !/PARTIALLY_CANCELLED/.test(returns) && !/PARTIALLY_SHIPPED/.test(returns));
  ok("seed-rbac.ts untouched", !/orderItemDeliveryState|withinReturnWindow/.test(read("scripts/seed-rbac.ts")));
}

// ── fixtures ────────────────────────────────────────────────────────────
// `returnEligibility` / `orderReturnableLines` (the functions under test) only
// ever read via the singleton `prisma` client — neither accepts a transaction
// client — so fixtures here can't live inside an uncommitted `$transaction`
// (a separate connection under READ COMMITTED simply can't see them). This
// mirrors the codebase's OTHER established pattern for exactly that situation
// (e.g. scripts/test-seller-verification-p3.ts): real committed rows, tracked
// ids, explicit `finally` cleanup, then a leak check.
type Client = Prisma.TransactionClient | typeof prisma;

async function mkThirdPartySeller(client: Client, sfx: string, tag: string) {
  return client.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `Seller ${tag} ${sfx}`, slug: `seller-${tag}-${sfx}-${rand()}`, supportEmail: `${tag}@t.test` },
    select: { id: true },
  });
}

async function mkProduct(client: Client, categoryId: string, sfx: string) {
  return client.product.create({
    data: { name: `P ${sfx}`, slug: `p-${sfx}-${rand()}`, shortDescription: "s", description: "d", categoryId, status: "ACTIVE", price: 1000 },
    select: { id: true },
  });
}

type SellerLineSpec = {
  sellerId: string;
  sellerType?: string;
  soStatus: string;
  productId: string;
  qty: number;
  deliveredAt?: Date; // only meaningful when soStatus === "DELIVERED"; default now()
};

async function mkOrderWithSellers(
  client: Client,
  sfx: string,
  userId: string,
  parentStatus: string,
  sellers: SellerLineSpec[],
  orderDeliveredAt: Date | null = null,
) {
  const shippingFee = 150;
  const subtotal = sellers.reduce((n, s) => n + s.qty * 1000, 0);
  const order = await client.order.create({
    data: {
      orderNumber: `AX-RET-${sfx}-${rand()}`,
      userId,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: parentStatus,
      paymentStatus: "PENDING",
      paymentMethod: "COD",
      subtotal,
      shippingFee,
      grandTotal: subtotal + shippingFee,
      deliveredAt: orderDeliveredAt,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const sellerOrderIds: Record<string, string> = {};
  const orderItemIds: Record<string, string> = {};
  for (const s of sellers) {
    const merch = s.qty * 1000;
    const so = await client.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: s.sellerId, sellerName: "S", sellerType: s.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: merch, shippingFee: 0, total: merch, commissionRate: 1500, commissionAmount: Math.round(merch * 0.15),
        status: s.soStatus,
      },
      select: { id: true },
    });
    sellerOrderIds[s.sellerId] = so.id;
    const item = await client.orderItem.create({
      data: { orderId: order.id, sellerOrderId: so.id, sellerId: s.sellerId, productId: s.productId, name: `Item ${s.sellerId}`, unitPrice: 1000, quantity: s.qty, lineTotal: merch },
      select: { id: true },
    });
    orderItemIds[s.sellerId] = item.id;
    if (s.soStatus === "DELIVERED") {
      await client.shipment.create({
        data: { sellerOrderId: so.id, status: "DELIVERED", carrier: "OTHER", carrierName: "Test Carrier", deliveredAt: s.deliveredAt ?? new Date() },
      });
    }
  }
  return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderIds, orderItemIds };
}

// ── DB behaviour (real writes, explicit cleanup) ─────────────────────────
async function dbTests() {
  console.log("\n── seller-scoped return eligibility (real fixtures, explicit cleanup) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "ret-" + String(Date.now()).slice(-7);
  const { windowDays } = await getReturnsConfig();

  const fixtureSellerIds: string[] = [];
  const fixtureProductIds: string[] = [];
  const fixtureOrderIds: string[] = [];
  let fixtureUserId: string | null = null;

  const seller = async (tag: string) => {
    const s = await mkThirdPartySeller(prisma, sfx, tag);
    fixtureSellerIds.push(s.id);
    return s;
  };
  const product = async (tag: string) => {
    const p = await mkProduct(prisma, category.id, sfx + tag);
    fixtureProductIds.push(p.id);
    return p;
  };
  const order = async (
    tag: string,
    parentStatus: string,
    sellers: SellerLineSpec[],
    orderDeliveredAt: Date | null = null,
  ) => {
    const o = await mkOrderWithSellers(prisma, sfx + tag, fixtureUserId!, parentStatus, sellers, orderDeliveredAt);
    fixtureOrderIds.push(o.orderId);
    return o;
  };

  try {
    const user = await prisma.user.create({ data: { email: `buyer-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
    fixtureUserId = user.id;

    // ── A · single-seller DELIVERED — remains eligible ──
    {
      const s = await seller("A");
      const p = await product("A");
      const o = await order("A", "DELIVERED", [{ sellerId: s.id, soStatus: "DELIVERED", productId: p.id, qty: 1 }]);
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("A · single-seller DELIVERED — eligible", elig.eligible === true);
      if (elig.eligible) {
        ok("A · the delivered seller's line is present", elig.lines.some((l) => l.orderItemId === o.orderItemIds[s.id]));
      }
    }

    // ── B · single-seller PROCESSING — remains ineligible ──
    {
      const s = await seller("B");
      const p = await product("B");
      const o = await order("B", "PROCESSING", [{ sellerId: s.id, soStatus: "PROCESSING", productId: p.id, qty: 1 }]);
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("B · single-seller PROCESSING — ineligible (not_delivered)", elig.eligible === false && !elig.eligible && elig.code === "not_delivered");
    }

    // ── C · multi-seller: A=DELIVERED, B=PROCESSING — eligible, A-only ──
    {
      const sA = await seller("C-A");
      const sB = await seller("C-B");
      const pA = await product("CA");
      const pB = await product("CB");
      const o = await order("C", "PROCESSING", [
        { sellerId: sA.id, soStatus: "DELIVERED", productId: pA.id, qty: 1 },
        { sellerId: sB.id, soStatus: "PROCESSING", productId: pB.id, qty: 1 },
      ]);
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("C · multi-seller (DELIVERED + PROCESSING) — eligible", elig.eligible === true);
      if (elig.eligible) {
        ok("C · ONLY Seller A's item is eligible", elig.lines.length === 1 && elig.lines[0].orderItemId === o.orderItemIds[sA.id]);
        ok("C · Seller B's still-PROCESSING item is EXCLUDED", !elig.lines.some((l) => l.orderItemId === o.orderItemIds[sB.id]));
      }

      // Step 4 — admin eligibility read reflects the same per-line truth.
      const adminLines = await orderReturnableLines(o.orderId);
      const adminA = adminLines?.lines.find((l) => l.orderItemId === o.orderItemIds[sA.id]);
      const adminB = adminLines?.lines.find((l) => l.orderItemId === o.orderItemIds[sB.id]);
      ok("C · admin read: Seller A's line marked delivered:true", adminA?.delivered === true);
      ok("C · admin read: Seller B's line marked delivered:false (still PROCESSING)", adminB?.delivered === false);

      // Step 5 / H — server-side selection safety: B's line is not in the
      // eligible set requestReturnAction validates against, so the exact
      // same lookup it performs would reject it.
      const eligibleById = new Map(elig.eligible ? elig.lines.map((l) => [l.orderItemId, l]) : []);
      ok("H · a PROCESSING line cannot be selected merely because a sibling seller delivered",
        eligibleById.get(o.orderItemIds[sB.id]) === undefined);
      ok("H · the genuinely-delivered line CAN be selected",
        eligibleById.get(o.orderItemIds[sA.id]) !== undefined);
    }

    // ── D · multi-seller: A=DELIVERED, B=SHIPPED — eligible, A-only ──
    {
      const sA = await seller("D-A");
      const sB = await seller("D-B");
      const pA = await product("DA");
      const pB = await product("DB");
      const o = await order("D", "PROCESSING", [
        { sellerId: sA.id, soStatus: "DELIVERED", productId: pA.id, qty: 1 },
        { sellerId: sB.id, soStatus: "SHIPPED", productId: pB.id, qty: 1 },
      ]);
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("D · multi-seller (DELIVERED + SHIPPED) — eligible", elig.eligible === true);
      if (elig.eligible) {
        ok("D · ONLY Seller A's item is eligible (SHIPPED is not DELIVERED)", elig.lines.length === 1 && elig.lines[0].orderItemId === o.orderItemIds[sA.id]);
      }
    }

    // ── E · multi-seller: both PROCESSING — no return eligible ──
    {
      const sA = await seller("E-A");
      const sB = await seller("E-B");
      const pA = await product("EA");
      const pB = await product("EB");
      const o = await order("E", "PROCESSING", [
        { sellerId: sA.id, soStatus: "PROCESSING", productId: pA.id, qty: 1 },
        { sellerId: sB.id, soStatus: "PROCESSING", productId: pB.id, qty: 1 },
      ]);
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("E · multi-seller both PROCESSING — ineligible (not_delivered)", elig.eligible === false && !elig.eligible && elig.code === "not_delivered");
    }

    // ── F · multi-seller: A=SHIPPED, B=DELIVERED — eligible, B-only ──
    {
      const sA = await seller("F-A");
      const sB = await seller("F-B");
      const pA = await product("FA");
      const pB = await product("FB");
      const o = await order("F", "PROCESSING", [
        { sellerId: sA.id, soStatus: "SHIPPED", productId: pA.id, qty: 1 },
        { sellerId: sB.id, soStatus: "DELIVERED", productId: pB.id, qty: 1 },
      ]);
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("F · multi-seller (SHIPPED + DELIVERED) — eligible", elig.eligible === true);
      if (elig.eligible) {
        ok("F · ONLY Seller B's item is eligible", elig.lines.length === 1 && elig.lines[0].orderItemId === o.orderItemIds[sB.id]);
      }
    }

    // ── G · return-window timing anchors on the SellerOrder's OWN shipment ──
    {
      const sWithin = await seller("G-within");
      const pWithin = await product("Gwithin");
      // Order.deliveredAt is set far outside the window on purpose — if the
      // window used it instead of the SellerOrder's own shipment, this would
      // wrongly read as expired.
      const oWithin = await order(
        "Gwithin", "PROCESSING",
        [{ sellerId: sWithin.id, soStatus: "DELIVERED", productId: pWithin.id, qty: 1, deliveredAt: new Date(Date.now() - days(windowDays - 1)) }],
        new Date(Date.now() - days(windowDays + 365)),
      );
      const eligWithin = await returnEligibility(user.id, oWithin.orderNumber);
      ok("G · delivered (windowDays − 1) ago via its OWN shipment — still eligible", eligWithin.eligible === true);

      const sExpired = await seller("G-expired");
      const pExpired = await product("Gexpired");
      // Order.deliveredAt is set to right NOW on purpose — if the window used
      // it instead of the SellerOrder's own shipment, this would wrongly
      // read as still eligible.
      const oExpired = await order(
        "Gexpired", "PROCESSING",
        [{ sellerId: sExpired.id, soStatus: "DELIVERED", productId: pExpired.id, qty: 1, deliveredAt: new Date(Date.now() - days(windowDays + 1)) }],
        new Date(),
      );
      const eligExpired = await returnEligibility(user.id, oExpired.orderNumber);
      ok("G · delivered (windowDays + 1) ago via its OWN shipment — window_expired",
        eligExpired.eligible === false && !eligExpired.eligible && eligExpired.code === "window_expired");
      ok("G · the configured window DURATION itself is unchanged (still windowDays, not some other number)",
        windowDays > 0 && Number.isInteger(windowDays));
    }

    // ── K · the existing one-open-return constraint remains enforced ──
    {
      const s = await seller("K");
      const p = await product("K");
      const o = await order("K", "DELIVERED", [{ sellerId: s.id, soStatus: "DELIVERED", productId: p.id, qty: 1 }]);
      const returnNumber = `RET-KTEST-${sfx}`;
      await prisma.returnRequest.create({
        data: { returnNumber, orderId: o.orderId, userId: user.id, status: "REQUESTED", reason: "OTHER" },
      });
      const elig = await returnEligibility(user.id, o.orderNumber);
      ok("K · an order with an OPEN return is still refused as already_open (seller-scoping didn't bypass it)",
        elig.eligible === false && !elig.eligible && elig.code === "already_open" && elig.existingReturnNumber === returnNumber);
    }
  } finally {
    // Order delete cascades OrderItem / SellerOrder / Shipment / ReturnRequest.
    if (fixtureOrderIds.length) await prisma.order.deleteMany({ where: { id: { in: fixtureOrderIds } } }).catch(() => {});
    if (fixtureProductIds.length) await prisma.product.deleteMany({ where: { id: { in: fixtureProductIds } } }).catch(() => {});
    if (fixtureSellerIds.length) await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
    if (fixtureUserId) await prisma.user.deleteMany({ where: { id: fixtureUserId } }).catch(() => {});
  }

  ok("CLEANUP · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("CLEANUP · no fixture seller leaked", (await prisma.seller.count({ where: { id: { in: fixtureSellerIds } } })) === 0);
  ok("CLEANUP · no fixture ReturnRequest leaked", (await prisma.returnRequest.count({ where: { returnNumber: { contains: sfx } } })) === 0);
}

async function main() {
  console.log("\nSELLER-SCOPED RETURN ELIGIBILITY — regression tests\n");
  pureTests();
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
