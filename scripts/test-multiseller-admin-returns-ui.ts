/**
 * ADMIN MULTI-SELLER RETURN UI — presentation-only regression tests.
 *
 * The admin "start a return" panel used to (a) drop the already-computed
 * `delivered`/`deliveredAt` fields when mapping `orderReturnableLines()` rows
 * into the component's `Line[]` prop, and (b) warn on the STALE aggregate
 * `Order.status !== "DELIVERED"`, which is wrong on a multi-seller order (one
 * seller can be DELIVERED while the parent Order is still PROCESSING) and
 * silent when it shouldn't be (an aggregate DELIVERED order can still contain
 * a line whose OWN seller hasn't delivered, once orders regress to per-seller
 * status).
 *
 * The fix threads `orderReturnableLines()`'s already-correct per-line
 * `naturallyEligible` / `sellerName` / `deliveredAt` straight through the page
 * and into the component, which now shows a per-line badge + seller + delivered
 * date/window text, and a selection-based override warning instead of the old
 * static aggregate banner. `adminCreateReturnAction`'s own per-line override
 * computation (`src/lib/admin/returns-actions.ts`) is NOT touched — this is a
 * display-only fix reusing that same already-correct backend truth.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-multiseller-admin-returns-ui.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { orderReturnableLines } from "@/lib/admin/returns";
import { getReturnsConfig } from "@/lib/returns";

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

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const page = read("src/app/admin/(shell)/orders/[id]/page.tsx");
  const component = read("src/components/admin/returns/admin-start-return.tsx");
  const adminActions = read("src/lib/admin/returns-actions.ts");
  const adminReturns = read("src/lib/admin/returns.ts");
  const returns = read("src/lib/returns.ts");
  const schema = read("prisma/schema.prisma");

  // D — the stale aggregate warning is gone.
  ok("component no longer takes an orderStatus prop",
    !/orderStatus/.test(component));
  ok("page no longer passes orderStatus to AdminStartReturn",
    !/<AdminStartReturn[\s\S]*?orderStatus=/.test(page));
  ok("the old static aggregate banner ('not delivered — creating a return here will be recorded as an override') is gone",
    !/not delivered — creating a return here will be recorded as an override/.test(component));

  // A/B/C/E — per-line delivered/deliveredAt/sellerName/naturallyEligible now flow through.
  ok("page maps naturallyEligible from orderReturnableLines into the component's lines prop",
    /naturallyEligible: l\.naturallyEligible/.test(page));
  ok("page maps sellerName from orderReturnableLines into the component's lines prop",
    /sellerName: l\.sellerName/.test(page));
  ok("page pre-formats deliveredAt into a plain string server-side (no Date crossing the Client Component boundary)",
    /deliveredAtLabel: l\.deliveredAt \? formatDate\(l\.deliveredAt\) : null/.test(page));
  ok("component's Line type carries sellerName / naturallyEligible / deliveredAtLabel / daysRemaining",
    /sellerName: string \| null/.test(component) &&
      /naturallyEligible: boolean/.test(component) &&
      /deliveredAtLabel: string \| null/.test(component) &&
      /daysRemaining: number \| null/.test(component));

  // D — per-line eligible/ineligible visual distinction + accurate, selection-scoped override warning.
  ok("component renders a per-line StatusBadge keyed off naturallyEligible (visual eligible/ineligible distinction)",
    /StatusBadge tone=\{l\.naturallyEligible \? "success" : "warning"\}/.test(component));
  ok("component computes the override warning from the SELECTED lines, not the whole order",
    /selectionRequiresOverride = selectedLines\.some\(\(l\) => !l\.naturallyEligible\)/.test(component));
  ok("component only shows the dynamic override warning when a selected line actually needs one",
    /\{selectionRequiresOverride && \(/.test(component));
  ok("component shows an explanatory note only when some line on the order is ineligible (not unconditionally)",
    /anyIneligibleOnOrder = lines\.some\(\(l\) => !l\.naturallyEligible\)/.test(component) &&
      /\{anyIneligibleOnOrder && \(/.test(component));

  // Seller name / delivered-date / return-window visibility.
  ok("component displays the seller name per line",
    /\{l\.sellerName && <p[^>]*>Seller: \{l\.sellerName\}<\/p>\}/.test(component));
  ok("component displays the delivered date per line",
    /Delivered \{l\.deliveredAtLabel\}/.test(component) || /\{l\.deliveredAtLabel\}/.test(component));
  ok("component displays days-remaining / window-passed per line, reusing the same daysRemaining the server computed (no re-derivation)",
    /l\.daysRemaining !== null/.test(component) && !/import.*withinReturnWindow/.test(component));

  // F — server-side validation untouched; UI only displays it.
  ok("admin/returns-actions.ts's per-line override computation is UNCHANGED (still orderItemDeliveryState-based, per line)",
    /const state = orderItemDeliveryState\(order, it\.sellerOrder\);/.test(adminActions) &&
      /overridden\.add\("status"\)/.test(adminActions) &&
      /overridden\.add\("window"\)/.test(adminActions));
  ok("admin/returns.ts's orderReturnableLines still reuses withinReturnWindow (no duplicated window rule)",
    /withinReturnWindow\(state\.deliveredAt, windowDays, now\)/.test(adminReturns));
  ok("returns.ts's returnEligibility (customer-side rule) is untouched by this UI fix",
    /orderItemDeliveryState\(order, it\.sellerOrder\)/.test(returns));

  // Scope — everything the task said not to touch.
  ok("no schema change", !/model ReturnRequest \{[^}]*sellerOrderId/.test(schema));
  ok("the one-open-return-per-order constraint is unchanged",
    /CREATE UNIQUE INDEX "return_one_open_per_order" ON "ReturnRequest"\("orderId"\)/.test(schema));
  ok("seed-rbac.ts untouched by this UI fix",
    !/naturallyEligible|orderReturnableLines/.test(read("scripts/seed-rbac.ts")));
}

// ── fixtures ────────────────────────────────────────────────────────────
type Client = Prisma.TransactionClient | typeof prisma;

async function mkThirdPartySeller(client: Client, sfx: string, tag: string, name: string) {
  return client.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: name, slug: `seller-${tag}-${sfx}-${rand()}`, supportEmail: `${tag}@t.test` },
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
  sellerName: string;
  soStatus: string;
  productId: string;
  qty: number;
  deliveredAt?: Date;
};

async function mkOrderWithSellers(
  client: Client,
  sfx: string,
  userId: string,
  parentStatus: string,
  sellers: SellerLineSpec[],
) {
  const shippingFee = 150;
  const subtotal = sellers.reduce((n, s) => n + s.qty * 1000, 0);
  const order = await client.order.create({
    data: {
      orderNumber: `AX-ADMRET-${sfx}-${rand()}`,
      userId,
      email: "buyer@example.test",
      phone: "+639000000000",
      status: parentStatus,
      paymentStatus: "PENDING",
      paymentMethod: "COD",
      subtotal,
      shippingFee,
      grandTotal: subtotal + shippingFee,
      shippingAddress: JSON.stringify({ firstName: "T", lastName: "B", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000", country: "PH" }),
    },
    select: { id: true, orderNumber: true },
  });
  const orderItemIds: Record<string, string> = {};
  for (const s of sellers) {
    const merch = s.qty * 1000;
    const so = await client.sellerOrder.create({
      data: {
        orderId: order.id, sellerId: s.sellerId, sellerName: s.sellerName, sellerType: s.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test",
        merchandiseSubtotal: merch, shippingFee: 0, total: merch, commissionRate: 1500, commissionAmount: Math.round(merch * 0.15),
        status: s.soStatus,
      },
      select: { id: true },
    });
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
  return { orderId: order.id, orderNumber: order.orderNumber, orderItemIds };
}

// ── DB behaviour (real writes, explicit cleanup) ─────────────────────────
async function dbTests() {
  console.log("\n── admin per-line return data (real fixtures, explicit cleanup) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const sfx = "admret-" + String(Date.now()).slice(-7);
  const { windowDays } = await getReturnsConfig();

  const fixtureSellerIds: string[] = [];
  const fixtureProductIds: string[] = [];
  const fixtureOrderIds: string[] = [];
  let fixtureUserId: string | null = null;

  const seller = async (tag: string, name: string) => {
    const s = await mkThirdPartySeller(prisma, sfx, tag, name);
    fixtureSellerIds.push(s.id);
    return s;
  };
  const product = async (tag: string) => {
    const p = await mkProduct(prisma, category.id, sfx + tag);
    fixtureProductIds.push(p.id);
    return p;
  };
  const order = async (tag: string, parentStatus: string, sellers: SellerLineSpec[]) => {
    const o = await mkOrderWithSellers(prisma, sfx + tag, fixtureUserId!, parentStatus, sellers);
    fixtureOrderIds.push(o.orderId);
    return o;
  };

  try {
    const user = await prisma.user.create({ data: { email: `buyer-${sfx}@t.test`, name: "Buyer" }, select: { id: true } });
    fixtureUserId = user.id;

    // ── A · single-seller DELIVERED — the line reads eligible + seller + delivered date ──
    {
      const s = await seller("A", "Seller A Co");
      const p = await product("A");
      const deliveredAt = new Date(Date.now() - days(3));
      const o = await order("A", "DELIVERED", [{ sellerId: s.id, sellerName: "Seller A Co", soStatus: "DELIVERED", productId: p.id, qty: 1, deliveredAt }]);
      const lines = await orderReturnableLines(o.orderId);
      const line = lines?.lines.find((l) => l.orderItemId === o.orderItemIds[s.id]);
      ok("A · line is present", !!line);
      ok("A · naturallyEligible true", line?.naturallyEligible === true);
      ok("A · sellerName carried through", line?.sellerName === "Seller A Co");
      ok("A · deliveredAt matches the shipment's own timestamp", line?.deliveredAt?.getTime() === deliveredAt.getTime());
      ok("A · daysRemaining computed and positive (within window)", (line?.daysRemaining ?? -1) > 0);
    }

    // ── B · multi-seller: A=DELIVERED, B=PROCESSING — A visibly eligible, B visibly not ──
    {
      const sA = await seller("B-A", "Seller B-A");
      const sB = await seller("B-B", "Seller B-B");
      const pA = await product("BA");
      const pB = await product("BB");
      const o = await order("B", "PROCESSING", [
        { sellerId: sA.id, sellerName: "Seller B-A", soStatus: "DELIVERED", productId: pA.id, qty: 1 },
        { sellerId: sB.id, sellerName: "Seller B-B", soStatus: "PROCESSING", productId: pB.id, qty: 1 },
      ]);
      const lines = await orderReturnableLines(o.orderId);
      const lineA = lines?.lines.find((l) => l.orderItemId === o.orderItemIds[sA.id]);
      const lineB = lines?.lines.find((l) => l.orderItemId === o.orderItemIds[sB.id]);
      ok("B · aggregate Order.status is still PROCESSING (the old bug's exact false-negative trigger)", lines?.order.status === "PROCESSING");
      ok("B · Seller A's line is naturallyEligible despite the aggregate status", lineA?.naturallyEligible === true);
      ok("B · Seller B's still-PROCESSING line is NOT naturallyEligible", lineB?.naturallyEligible === false);
      ok("B · Seller B's line has no deliveredAt (never delivered)", lineB?.deliveredAt === null);
      ok("B · Seller B's line has no daysRemaining (nothing to count down)", lineB?.daysRemaining === null);
    }

    // ── C · mixed 1P + 3P: legacy 1P line (no SellerOrder) + a 3P DELIVERED line ──
    {
      const s3p = await seller("C-3p", "Seller C 3P");
      const p3p = await product("C3p");
      const p1p = await product("C1p");
      const o = await order("C", "DELIVERED", [{ sellerId: s3p.id, sellerName: "Seller C 3P", soStatus: "DELIVERED", productId: p3p.id, qty: 1 }]);
      // Add a second, legacy 1P-style line with no SellerOrder directly (mirrors a pre-marketplace OrderItem).
      const legacyItem = await prisma.orderItem.create({
        data: { orderId: o.orderId, sellerOrderId: null, productId: p1p.id, name: "Legacy 1P item", unitPrice: 1000, quantity: 1, lineTotal: 1000 },
        select: { id: true },
      });
      const lines = await orderReturnableLines(o.orderId);
      const line3p = lines?.lines.find((l) => l.orderItemId === o.orderItemIds[s3p.id]);
      const lineLegacy = lines?.lines.find((l) => l.orderItemId === legacyItem.id);
      ok("C · the 3P line shows its own seller name", line3p?.sellerName === "Seller C 3P");
      ok("C · the 3P line is naturallyEligible", line3p?.naturallyEligible === true);
      ok("C · the legacy line (no SellerOrder) has no sellerName", lineLegacy?.sellerName === null);
      ok("C · the legacy line falls back to the whole-order status (DELIVERED here) — naturallyEligible true",
        lineLegacy?.naturallyEligible === true);
    }

    // ── E · deliveredAt / daysRemaining propagate correctly at the window edge ──
    {
      const s = await seller("E", "Seller E");
      const p = await product("E");
      const deliveredAt = new Date(Date.now() - days(windowDays + 1)); // just past the window
      const o = await order("E", "DELIVERED", [{ sellerId: s.id, sellerName: "Seller E", soStatus: "DELIVERED", productId: p.id, qty: 1, deliveredAt }]);
      const lines = await orderReturnableLines(o.orderId);
      const line = lines?.lines.find((l) => l.orderItemId === o.orderItemIds[s.id]);
      ok("E · delivered but past the window — naturallyEligible false", line?.naturallyEligible === false);
      ok("E · deliveredAt is still surfaced even though the window passed (so the UI can say WHY, not just NO)",
        line?.deliveredAt?.getTime() === deliveredAt.getTime());
      ok("E · daysRemaining is negative once the window has passed", (line?.daysRemaining ?? 1) < 0);
    }
  } finally {
    if (fixtureOrderIds.length) await prisma.order.deleteMany({ where: { id: { in: fixtureOrderIds } } }).catch(() => {});
    if (fixtureProductIds.length) await prisma.product.deleteMany({ where: { id: { in: fixtureProductIds } } }).catch(() => {});
    if (fixtureSellerIds.length) await prisma.seller.deleteMany({ where: { id: { in: fixtureSellerIds } } }).catch(() => {});
    if (fixtureUserId) await prisma.user.deleteMany({ where: { id: fixtureUserId } }).catch(() => {});
  }

  ok("CLEANUP · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("CLEANUP · no fixture seller leaked", (await prisma.seller.count({ where: { id: { in: fixtureSellerIds } } })) === 0);
}

async function main() {
  console.log("\nADMIN MULTI-SELLER RETURN UI — presentation-only regression tests\n");
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
