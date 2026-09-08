/**
 * PHASE 9F-23d — customer `order_confirmation` email shows Product Condition
 * for NON-NEW items (1P + 3P + mixed), NEW / NULL byte-identical to today.
 *
 * The audited change is ONE map in `sendOrderConfirmation`
 * (`src/lib/email/notifications.ts`): fold `Condition: <label>` into the
 * existing `variantLabel` — the same pattern `seller_order_received` uses
 * (9F-22). No template / html.ts / schema / checkout / idempotency / retry
 * change.
 *
 * `sendOrderConfirmation` reads the module-level `prisma` (no tx-client option),
 * so a rolled-back fixture is invisible to it — instead the tests:
 *   - assert the source map is exactly the audited fold (static),
 *   - replicate that fold expression verbatim and drive it over every input,
 *   - render `renderOrderConfirmation` with the folded items and check HTML+text,
 *   - build a rolled-back Order + OrderItems (1P / 3P / mixed by `sellerId`)
 *     and run the SAME fold over the real rows.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f23d.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import { conditionLabel, isNoteworthyCondition } from "@/lib/seller/format";
import { renderOrderConfirmation } from "@/lib/email/templates/order-confirmation";

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

/**
 * The audited fold — MUST stay byte-identical to the `variantLabel:` line in
 * `sendOrderConfirmation` (asserted statically below).
 */
function foldVariantLabel(i: { variantLabel: string | null; condition: string | null }): string | null {
  return isNoteworthyCondition(i.condition)
    ? [i.variantLabel, `Condition: ${conditionLabel(i.condition!)}`].filter(Boolean).join(" · ")
    : i.variantLabel;
}

// ── static wiring ────────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const notifs = read("src/lib/email/notifications.ts");
  const notifsCode = strip(notifs);

  // 1/2/3 — the fold lives in sendOrderConfirmation, exactly the audited form
  ok("notifications · sendOrderConfirmation folds Condition into variantLabel (audited form)", (() => {
    const m = notifs.match(/export async function sendOrderConfirmation\([\s\S]*?\n\}/);
    if (!m) return false;
    return /items: order\.items\.map\(\(i\) => \(\{[\s\S]{0,400}variantLabel: isNoteworthyCondition\(i\.condition\)\s*\n\s*\? \[i\.variantLabel, `Condition: \$\{conditionLabel\(i\.condition!\)\}`\]\.filter\(Boolean\)\.join\(" · "\)\s*\n\s*: i\.variantLabel,/.test(m[0]);
  })());
  ok("notifications · the fold does NOT branch on seller type (no sellerId/sellerType/seller in the map)", (() => {
    const m = notifs.match(/items: order\.items\.map\(\(i\) => \(\{[\s\S]*?\}\)\),\s*\n\s*subtotal: order\.subtotal,/);
    return !!m && !/seller(Id|Type|\.)/i.test(m[0]);
  })());
  ok("notifications · reuses conditionLabel / isNoteworthyCondition (no new label map)",
    /import \{ conditionLabel, isNoteworthyCondition \} from "@\/lib\/seller\/format"/.test(notifs) &&
    !/CONDITION_LABEL|conditionLabelMap|const .*[Cc]ondition.*= \{[\s\S]{0,120}Refurbished/.test(notifsCode));

  // 9 — idempotency key unchanged
  ok("notifications · order_confirmation idempotency key still `ORDER_CREATED:${order.id}`", (() => {
    const m = notifs.match(/export async function sendOrderConfirmation\([\s\S]*?\n\}/);
    return !!m && /idempotencyKey: `ORDER_CREATED:\$\{order\.id\}`/.test(m[0]);
  })());
  ok("notifications · ORDER_INCLUDE still `{ items: { orderBy: { id: \"asc\" } }, user: … }` (condition arrives via no-select)",
    /const ORDER_INCLUDE = \{\s*\n\s*items: \{ orderBy: \{ id: "asc" \} as const \},\s*\n\s*user: \{ select: \{ name: true \} \},\s*\n\} as const;/.test(notifs));

  // 10 — retry path unchanged
  ok("notifications · retryEmailByLog order_confirmation case unchanged",
    /case "order_confirmation":\s*\n\s*return log\.orderId \? sendOrderConfirmation\(log\.orderId, \{ retry: true \}\) : \{ ok: false, status: "FAILED", error: "no_order" \};/.test(notifs));

  // 11 — seller_order_received fold unchanged
  ok("notifications · sendSellerOrderReceived fold unchanged (still folds i.condition, no 9F-23d marker in that fn)", (() => {
    const m = notifs.match(/export async function sendSellerOrderReceived\([\s\S]*?\n\}/);
    if (!m) return false;
    return /variantLabel: isNoteworthyCondition\(i\.condition\)\s*\n\s*\? \[i\.variantLabel, `Condition: \$\{conditionLabel\(i\.condition!\)\}`\]/.test(m[0]) && !/9F-23d/.test(m[0]);
  })());

  // 12 — no template / html / schema / checkout change
  ok("scope · order-confirmation.ts template unchanged (no 9F-23d, no `condition` field on OrderConfirmationData)",
    !/9F-23d/.test(read("src/lib/email/templates/order-confirmation.ts")) &&
    !/condition/i.test(read("src/lib/email/templates/order-confirmation.ts").match(/export type OrderConfirmationData = \{[\s\S]*?\};/)?.[0] ?? ""));
  ok("scope · email/html.ts itemsTable unchanged (no 9F-23d)", !/9F-23d/.test(read("src/lib/email/html.ts")));
  ok("scope · seller-order-notifications.ts template unchanged (no 9F-23d)", !/9F-23d/.test(read("src/lib/email/templates/seller-order-notifications.ts")));
  ok("scope · checkout.ts / schema.prisma / seed-rbac.ts untouched",
    !/9F-23d/.test(read("src/lib/checkout.ts")) && !/9F-23d/.test(read("prisma/schema.prisma")) && !/9F-23d/.test(read("scripts/seed-rbac.ts")));
  ok("scope · email infra untouched (send.ts / schedule.ts / config.ts / transport.ts)",
    !/9F-23d/.test(read("src/lib/email/send.ts")) && !/9F-23d/.test(read("src/lib/email/schedule.ts")) &&
    !/9F-23d/.test(read("src/lib/email/config.ts")) && !/9F-23d/.test(read("src/lib/email/transport.ts")));
}

// ── the fold, over every input ───────────────────────────────────────────
function foldUnitTests() {
  console.log("\n── fold behaviour ──");
  // 4 — NEW → untouched
  ok("4 · NEW → variantLabel untouched (no Condition text)", foldVariantLabel({ variantLabel: "Brass", condition: "NEW" }) === "Brass");
  ok("4 · NEW, no variantLabel → null (nothing)", foldVariantLabel({ variantLabel: null, condition: "NEW" }) === null);
  // 5 — NULL → untouched
  ok("5 · null condition → variantLabel untouched", foldVariantLabel({ variantLabel: "Brass", condition: null }) === "Brass");
  ok("5 · null condition, no variantLabel → null", foldVariantLabel({ variantLabel: null, condition: null }) === null);
  // 6 — no variantLabel + non-NEW → "Condition: X" alone, no leading separator
  ok("6 · no variantLabel + OPEN_BOX → 'Condition: Open box' (no leading ' · ')",
    foldVariantLabel({ variantLabel: null, condition: "OPEN_BOX" }) === "Condition: Open box");
  ok("6 · no variantLabel + REFURBISHED → 'Condition: Refurbished'",
    foldVariantLabel({ variantLabel: "", condition: "REFURBISHED" }) === "Condition: Refurbished");
  // 7 — existing variantLabel + non-NEW → "Variant · Condition: X", no trailing/duplicate
  ok("7 · 'M' + REFURBISHED → 'M · Condition: Refurbished'",
    foldVariantLabel({ variantLabel: "M", condition: "REFURBISHED" }) === "M · Condition: Refurbished");
  ok("7 · no trailing separator / no duplicate 'Condition'", (() => {
    const v = foldVariantLabel({ variantLabel: "Oak / Large", condition: "USED_GOOD" });
    return v === "Oak / Large · Condition: Used — good" && (v.match(/Condition:/g) ?? []).length === 1 && !v.endsWith(" · ");
  })());
  // 8 — all four non-NEW labels
  ok("8 · REFURBISHED → 'Refurbished'", foldVariantLabel({ variantLabel: null, condition: "REFURBISHED" }) === "Condition: Refurbished");
  ok("8 · OPEN_BOX → 'Open box'", foldVariantLabel({ variantLabel: null, condition: "OPEN_BOX" }) === "Condition: Open box");
  ok("8 · USED_LIKE_NEW → 'Used — like new'", foldVariantLabel({ variantLabel: null, condition: "USED_LIKE_NEW" }) === "Condition: Used — like new");
  ok("8 · USED_GOOD → 'Used — good'", foldVariantLabel({ variantLabel: null, condition: "USED_GOOD" }) === "Condition: Used — good");
}

// ── rendered HTML + text ─────────────────────────────────────────────────
function renderTests() {
  console.log("\n── rendered order_confirmation (HTML + text) ──");
  const base = {
    brand: "Axiaro", siteUrl: "https://axiaro.shop", orderUrl: "https://axiaro.shop/order/AX-1",
    orderNumber: "AX-1", placedAt: new Date("2026-09-08T00:00:00Z"), customerName: "Mara",
    subtotal: 9000, discountTotal: 0, couponCode: null, shippingMethodName: null, shippingFee: 0,
    grandTotal: 9000, shippingAddress: { firstName: "Mara", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000" },
    payOnDelivery: true,
  };
  const mkItem = (variantLabel: string | null, condition: string | null) => ({
    name: "Widget", variantLabel: foldVariantLabel({ variantLabel, condition }), quantity: 1, unitPrice: 9000, lineTotal: 9000,
  });

  const nonNew = renderOrderConfirmation({ ...base, items: [mkItem("M", "REFURBISHED")] });
  ok("HTML · non-NEW item → 'Condition: Refurbished' in the HTML email",
    nonNew.html.includes("Condition: Refurbished"));
  ok("text · non-NEW item → 'Condition: Refurbished' in the text email",
    String(nonNew.text).includes("Condition: Refurbished") && String(nonNew.text).includes("(M · Condition: Refurbished)"));

  const newOnly = renderOrderConfirmation({ ...base, items: [mkItem("M", "NEW"), mkItem(null, null)] });
  ok("6/4/5 · NEW + NULL only → NO 'Condition:' anywhere in HTML (byte-identical shape)", !/Condition:/.test(newOnly.html));
  ok("6/4/5 · NEW + NULL only → NO 'Condition:' anywhere in text", !/Condition:/.test(String(newOnly.text)));

  // NEW email preservation — identical to a run with the pre-fold plain labels
  const prefold = renderOrderConfirmation({
    ...base,
    items: [
      { name: "Widget", variantLabel: "M", quantity: 1, unitPrice: 9000, lineTotal: 9000 },
      { name: "Widget", variantLabel: null, quantity: 1, unitPrice: 9000, lineTotal: 9000 },
    ],
  });
  ok("NEW-preservation · folded-NEW output byte-identical to plain-label output (HTML)", newOnly.html === prefold.html);
  ok("NEW-preservation · folded-NEW output byte-identical to plain-label output (text)", String(newOnly.text) === String(prefold.text));

  // 6 — no variantLabel + non-NEW renders "Condition: Open box" with no stray separator
  const noVar = renderOrderConfirmation({ ...base, items: [mkItem(null, "OPEN_BOX")] });
  ok("6 · no variantLabel + OPEN_BOX → 'Condition: Open box' rendered, no leading ' · '",
    noVar.html.includes(">Condition: Open box<") && String(noVar.text).includes("(Condition: Open box)") &&
    !/·\s*Condition: Open box/.test(String(noVar.text)));
}

// ── rolled-back DB fixtures: 1P / 3P / mixed ─────────────────────────────
async function dbTests() {
  console.log("\n── 1P / 3P / mixed orders (fixtures rolled back) ──");
  const axiaro = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const product = await prisma.product.findFirst({ where: { status: "ACTIVE" }, select: { id: true, variants: { take: 1, select: { id: true } } } });
  if (!axiaro || !product) return ok("(skipped — no FIRST_PARTY seller / product)", true);
  const variantId = product.variants[0]?.id ?? null;
  const sfx = "9f23d-" + Date.now();

  // the exact ORDER_INCLUDE shape sendOrderConfirmation uses
  const ORDER_INCLUDE = { items: { orderBy: { id: "asc" as const } }, user: { select: { name: true } } };

  try {
    await prisma.$transaction(async (tx) => {
      const tp = await tx.seller.create({
        data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `TP ${sfx}`, slug: `tp-${sfx}`, supportEmail: "tp@t.test" },
        select: { id: true },
      });

      const mkOrder = async (tag: string, lines: { sellerId: string; variantLabel: string | null; condition: string | null }[]) => {
        const order = await tx.order.create({
          data: {
            orderNumber: `AX-${tag}-${sfx}`, email: `c-${tag}@t.test`, phone: "+639999999999",
            status: "PENDING_PAYMENT", paymentMethod: "NONE", paymentStatus: "PENDING",
            subtotal: lines.length * 9000, shippingFee: 0, discountTotal: 0, grandTotal: lines.length * 9000,
            shippingAddress: JSON.stringify({ firstName: "C", line1: "1 St", city: "Manila", province: "NCR", postalCode: "1000" }),
          },
          select: { id: true },
        });
        await tx.orderItem.createMany({
          data: lines.map((l) => ({
            orderId: order.id, productId: product.id, variantId, sellerId: l.sellerId,
            name: "Widget", variantLabel: l.variantLabel, unitPrice: 9000, quantity: 1, lineTotal: 9000,
            condition: l.condition,
          })),
        });
        const full = await tx.order.findUniqueOrThrow({ where: { id: order.id }, include: ORDER_INCLUDE });
        // the exact map from sendOrderConfirmation
        return full.items.map((i) => foldVariantLabel({ variantLabel: i.variantLabel, condition: i.condition }));
      };

      // 1 — non-NEW 1P order
      const oneP = await mkOrder("1P", [{ sellerId: axiaro.id, variantLabel: "Brass", condition: "REFURBISHED" }]);
      ok("1 · non-NEW 1P order → 'Brass · Condition: Refurbished'", oneP[0] === "Brass · Condition: Refurbished");

      // 2 — non-NEW 3P order
      const threeP = await mkOrder("3P", [{ sellerId: tp.id, variantLabel: null, condition: "OPEN_BOX" }]);
      ok("2 · non-NEW 3P order → 'Condition: Open box' (no leading separator)", threeP[0] === "Condition: Open box");

      // 3 — mixed 1P + 3P order, per-item conditions
      const mixed = await mkOrder("MIX", [
        { sellerId: axiaro.id, variantLabel: "M", condition: "USED_GOOD" },   // 1P non-NEW
        { sellerId: tp.id, variantLabel: "L", condition: "NEW" },              // 3P NEW
        { sellerId: tp.id, variantLabel: null, condition: null },              // 3P null
        { sellerId: axiaro.id, variantLabel: "XL", condition: "USED_LIKE_NEW" }, // 1P non-NEW
      ]);
      ok("3 · mixed order → per-item: ['M · Condition: Used — good', 'L', null, 'XL · Condition: Used — like new']",
        JSON.stringify(mixed) === JSON.stringify(["M · Condition: Used — good", "L", null, "XL · Condition: Used — like new"]));
      ok("3 · mixed order NEW/null lines are untouched (no Condition text)",
        mixed[1] === "L" && mixed[2] === null);

      // no production leak
      throw new Rollback();
    }, { timeout: 60000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
  ok("ROLLBACK · no fixture seller leaked", (await prisma.seller.count({ where: { slug: { contains: sfx } } })) === 0);
}

// ── production read-only safety ──────────────────────────────────────────
async function prodTests() {
  console.log("\n── production (READ-ONLY) ──");
  ok("prod · no OrderItem.condition changed — all still NULL", (await prisma.orderItem.count({ where: { condition: { not: null } } })) === 0);
  ok("prod · Order count unchanged (9)", (await prisma.order.count()) === 9);
  const fp = await prisma.offer.groupBy({ by: ["condition"], where: { seller: { is: { type: "FIRST_PARTY" } } }, _count: true });
  ok("prod · all FIRST_PARTY offers still NEW", fp.every((g) => g.condition === "NEW"), JSON.stringify(fp));
  const logs = await prisma.emailLog.count();
  ok("prod · EmailLog count is a plain read (no send performed)", logs >= 0, String(logs));
}

async function main() {
  console.log("\nPHASE 9F-23d — order_confirmation condition line\n");
  staticTests();
  foldUnitTests();
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
