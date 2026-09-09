/**
 * PHASE 9F-32A — 3P seller-order acceptance SLA / stale-order escalation.
 *
 * A THIRD_PARTY SellerOrder auto-confirmed at checkout stays PENDING_PAYMENT
 * (parent Order PROCESSING) until the seller accepts. The hourly sweep
 * `runSellerOrderAcceptanceSla`:
 *   - >= 4h  → one seller reminder  (SELLER_ORDER_ACCEPTANCE_REMINDER:<id>)
 *   - >= 24h → one `seller_order.acceptance_overdue` audit row + one Ops email
 *              (SELLER_ORDER_ACCEPTANCE_OVERDUE:<id>)
 * Idempotent; re-reads current state; skips FIRST_PARTY / CANCELLED / completed.
 *
 * DB tests build fixtures inside ONE prisma.$transaction and roll back; the job
 * + senders take `{ client: tx }` and an injectable `now`. Local env has no
 * EMAIL_* config → `dispatchEmail` returns SKIPPED, never sends.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f32a.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient, Prisma } from "@prisma/client";
import {
  SELLER_ORDER_ACCEPTANCE_SLA,
  acceptanceAgeMs,
  acceptanceSlaStage,
  humanizeWait,
} from "@/lib/marketplace/seller-order-sla";
import { runSellerOrderAcceptanceSla } from "@/lib/marketplace/seller-order-sla-job";
import {
  sendSellerOrderAcceptanceReminder,
  sendSellerOrderAcceptanceOverdueOps,
} from "@/lib/email/notifications";
import {
  renderSellerOrderAcceptanceReminder,
} from "@/lib/email/templates/seller-order-notifications";
import { renderSellerOrderAcceptanceOverdueOps } from "@/lib/email/templates/ops-notifications";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
class Rollback extends Error {}

const HOUR = 60 * 60 * 1000;

// ── pure ────────────────────────────────────────────────────────────────
function pureTests() {
  console.log("\n── pure — SLA config + helpers ──");
  ok("reminder threshold = 4h, escalation = 24h (named constants)",
    SELLER_ORDER_ACCEPTANCE_SLA.reminderAfterMs === 4 * HOUR &&
    SELLER_ORDER_ACCEPTANCE_SLA.escalateAfterMs === 24 * HOUR);
  const base = new Date("2026-09-09T00:00:00Z");
  ok("age 3h59m → stage none", acceptanceSlaStage(acceptanceAgeMs(new Date(base.getTime() - (4 * HOUR - 60_000)), base)) === "none");
  ok("age 4h exactly → stage reminder", acceptanceSlaStage(acceptanceAgeMs(new Date(base.getTime() - 4 * HOUR), base)) === "reminder");
  ok("age 23h59m → stage reminder", acceptanceSlaStage(acceptanceAgeMs(new Date(base.getTime() - (24 * HOUR - 60_000)), base)) === "reminder");
  ok("age 24h exactly → stage overdue", acceptanceSlaStage(acceptanceAgeMs(new Date(base.getTime() - 24 * HOUR), base)) === "overdue");
  ok("age never negative (future createdAt)", acceptanceAgeMs(new Date(base.getTime() + HOUR), base) === 0);
  ok("humanizeWait: 5h → '5 hours', 25h → '1 day 1 hour', 48h → '2 days'",
    humanizeWait(5 * HOUR) === "5 hours" && humanizeWait(25 * HOUR) === "1 day 1 hour" && humanizeWait(48 * HOUR) === "2 days");
}

// ── static wiring ───────────────────────────────────────────────────────
function staticTests() {
  console.log("\n── static wiring ──");
  const sla = read("src/lib/marketplace/seller-order-sla.ts");
  const job = read("src/lib/marketplace/seller-order-sla-job.ts");
  const route = read("src/app/api/cron/seller-order-sla/route.ts");
  const vercel = read("vercel.json");
  const proxy = read("src/proxy.ts");
  const send = read("src/lib/email/send.ts");
  const notif = read("src/lib/email/notifications.ts");
  const opsTpl = read("src/lib/email/templates/ops-notifications.ts");
  const sellerTpl = read("src/lib/email/templates/seller-order-notifications.ts");

  ok("config · thresholds in ONE constants object, ms, no env var", /reminderAfterMs: 4 \* 60 \* 60 \* 1000/.test(sla) && /escalateAfterMs: 24 \* 60 \* 60 \* 1000/.test(sla) && !/process\.env/.test(sla));
  ok("config · exactly two SLA stages (none / reminder / overdue), no extra levels", /AcceptanceSlaStage = "none" \| "reminder" \| "overdue"/.test(sla) && !/critical|final|level3|stage3/i.test(sla));

  ok("job · query is THIRD_PARTY + PENDING_PAYMENT + parent Order PROCESSING (the state re-check)",
    /sellerType: "THIRD_PARTY",\s*\n\s*status: "PENDING_PAYMENT",\s*\n\s*order: \{ is: \{ status: "PROCESSING" \} \}/.test(job));
  ok("job · age from SellerOrder.createdAt (immutable, set at checkout) — NOT updatedAt",
    /acceptanceAgeMs\(so\.createdAt, now\)/.test(job) && !/updatedAt/.test(job));
  ok("job · reminder fired once, guarded by an existing EmailLog row for the key",
    /const alreadyReminded = \(await db\.emailLog\.count\(\{ where: \{ idempotencyKey: reminderKey \} \}\)\) > 0;\s*\n\s*if \(!alreadyReminded\)/.test(job));
  ok("job · escalation writes ONE seller_order.acceptance_overdue audit, guarded by an existence check",
    /const alreadyEscalated =\s*\n?\s*\(await db\.adminAuditLog\.count\(\{\s*\n\s*where: \{ action: OVERDUE_AUDIT_ACTION, targetType: "seller_order", targetId: so\.id \}/.test(job) &&
    /action: OVERDUE_AUDIT_ACTION,/.test(job) && /"seller_order\.acceptance_overdue"/.test(job));
  ok("job · never writes an order / SellerOrder / inventory / offer row",
    !/\b(tx|db|prisma|client)\.(order|sellerOrder|offerInventory|inventory|offer)\.(update|updateMany|create|delete|createMany)\b/.test(job));
  ok("job · never touches payments / returns / settlements (code, not comments)",
    (() => {
      const code = job.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");
      return !/\.payment[A-Za-z]*\.|\.returnRequest\.|\.sellerSettlement\.|settlementStatus\s*[:=]/i.test(code);
    })());

  ok("route · GET only, POST → 405", /export async function GET\(/.test(route) && /method not allowed", \{ status: 405/.test(route));
  ok("route · fails CLOSED + inert without CRON_SECRET (503), else Bearer check (401)",
    /if \(!secret\) \{[\s\S]{0,120}status: 503/.test(route) && /request\.headers\.get\("authorization"\) !== `Bearer \$\{secret\}`/.test(route));
  ok("route · nodejs runtime, force-dynamic", /export const runtime = "nodejs";/.test(route) && /export const dynamic = "force-dynamic";/.test(route));
  ok("vercel.json · cron registered for the sweep path (daily on Hobby; job is idempotent so cadence is safe to change)",
    /"path": "\/api\/cron\/seller-order-sla"/.test(vercel) && /"schedule": "0 9 \* \* \*"/.test(vercel));
  ok("proxy · api/cron excluded from the session middleware (like api/webhooks)", /api\/webhooks\|api\/cron/.test(proxy));

  ok("email · two new EmailTypes", /\| "seller_order_acceptance_reminder"/.test(send) && /\| "seller_order_acceptance_overdue_ops"/.test(send));
  ok("email · reminder sender re-reads state + SKIPs unless still 3P/PENDING_PAYMENT/parent PROCESSING",
    /so\.sellerType !== "THIRD_PARTY" \|\|\s*\n\s*so\.status !== "PENDING_PAYMENT" \|\|\s*\n\s*so\.order\.status !== "PROCESSING"/.test(notif));
  ok("email · reminder sender also SKIPs if age fell back below the reminder threshold",
    /if \(subj\.ageMs < SELLER_ORDER_ACCEPTANCE_SLA\.reminderAfterMs\) \{\s*\n\s*return \{ ok: true, skipped: true, status: "SKIPPED" \};/.test(notif));
  ok("email · reminder → SELLER (loadSellerLifecycleEmailContext), key SELLER_ORDER_ACCEPTANCE_REMINDER:<id>",
    /sendSellerOrderAcceptanceReminder[\s\S]{0,1200}loadSellerLifecycleEmailContext\(subj\.so\.sellerId/.test(notif) &&
    /`SELLER_ORDER_ACCEPTANCE_REMINDER:\$\{sellerOrderId\}`/.test(notif));
  ok("email · overdue → OPS inbox (getSupportInboxEmail), from ORDERS_FROM, key SELLER_ORDER_ACCEPTANCE_OVERDUE:<id>",
    /sendSellerOrderAcceptanceOverdueOps[\s\S]{0,900}getSupportInboxEmail\(\)/.test(notif) &&
    /type: "seller_order_acceptance_overdue_ops",\s*\n\s*to,\s*\n\s*from: ORDERS_FROM/.test(notif) &&
    /`SELLER_ORDER_ACCEPTANCE_OVERDUE:\$\{sellerOrderId\}`/.test(notif));
  ok("email · reminder template says accept/decline, NOT 'being packed'",
    /renderSellerOrderAcceptanceReminder/.test(sellerTpl) &&
    /Accept.{0,40}Decline|accept or decline/i.test(sellerTpl.slice(sellerTpl.indexOf("renderSellerOrderAcceptanceReminder"), sellerTpl.indexOf("renderSellerOrderAcceptanceReminder") + 2200)) &&
    !/being packed|picked and packed/i.test(sellerTpl.slice(sellerTpl.indexOf("renderSellerOrderAcceptanceReminder"), sellerTpl.indexOf("renderSellerOrderAcceptanceReminder") + 2200)));
  // 9F-34A — inline <strong> in the reminder body must be RENDERED HTML, not
  // escaped literal tags (the 9F-32A bug: <strong> went through paragraph() →
  // esc() → &lt;strong&gt;). Dynamic values still escaped.
  ok("email · 9F-34A · reminder body emits <strong> via paragraphHtml + esc()s dynamic values (never raw paragraph())",
    /paragraphHtml\(/.test(sellerTpl) &&
    /<strong>\$\{esc\(d\.waitedLabel\)\}<\/strong>/.test(sellerTpl) &&
    !/paragraph\(`[^`]*<strong>/.test(sellerTpl) &&
    /export function paragraphHtml\(html: string\): string/.test(read("src/lib/email/html.ts")));
  {
    const r = renderSellerOrderAcceptanceReminder({
      brand: "Axiaro", siteUrl: "https://x.test", sellerName: "Style & Co", orderNumber: "AX-1<2",
      ordersUrl: "https://x.test/seller/orders", orderUrl: "https://x.test/seller/orders/so1",
      waitedLabel: "1 day 8 hours", itemCount: 2,
    });
    ok("email · 9F-34A · rendered HTML body contains real <strong> tags, NOT &lt;strong&gt;",
      r.html.includes("<strong>1 day 8 hours</strong>") &&
      r.html.includes("<strong>Accept</strong>") &&
      r.html.includes("<strong>Decline</strong>") &&
      !r.html.includes("&lt;strong&gt;"));
    ok("email · 9F-34A · dynamic values in the rich paragraph ARE still escaped",
      r.html.includes("AX-1&lt;2") && r.html.includes("Style &amp; Co") && !r.html.includes(">AX-1<2<"));
    ok("email · 9F-34A · plain-text body is readable, no raw HTML tags",
      r.text.includes("1 day 8 hours") && r.text.includes("Accept it to start preparing") &&
      !/<\/?strong>|<\/?p>|&lt;|&amp;lt;/.test(r.text));
    ok("email · 9F-34A · subject / link / recipient-reason wording unchanged",
      r.subject === "Action needed: accept or decline order AX-1<2" &&
      r.html.includes("https://x.test/seller/orders/so1") &&
      r.html.includes("you manage a seller account on Axiaro"));
    // the ops escalation template was already plain paragraph() — regression-guard it stays tag-free
    const o = renderSellerOrderAcceptanceOverdueOps({
      brand: "Axiaro", siteUrl: "https://x.test", adminUrl: "https://x.test/admin/orders/o1",
      sellerName: "Style Avenue", orderNumber: "AX-2", sellerOrderStatus: "PENDING_PAYMENT",
      waitedLabel: "1 day 8 hours", thresholdLabel: "1 day", itemCount: 1, placedAt: new Date("2026-09-07T10:00:00Z"),
    });
    ok("email · 9F-34A · ops escalation body has no <strong>/literal-tag issue (was already plain paragraph())",
      !o.html.includes("&lt;strong&gt;") && !/<\/?strong>|<\/?p>|&lt;/.test(o.text));
  }
  ok("email · ops template carries NO customer PII",
    /renderSellerOrderAcceptanceOverdueOps/.test(opsTpl) &&
    !/customerName|customerEmail|\bphone\b|shippingAddress/.test(opsTpl.slice(opsTpl.indexOf("renderSellerOrderAcceptanceOverdueOps"), opsTpl.indexOf("renderSellerOrderAcceptanceOverdueOps") + 2400)));
  ok("email · retry-switch cases for both new types",
    /case "seller_order_acceptance_reminder": \{[\s\S]{0,260}sendSellerOrderAcceptanceReminder\(sellerOrderId/.test(notif) &&
    /case "seller_order_acceptance_overdue_ops": \{[\s\S]{0,260}sendSellerOrderAcceptanceOverdueOps\(sellerOrderId/.test(notif));
  ok("email · not_retryable count unchanged (2) — new cases route to their senders",
    (notif.match(/error: "not_retryable"/g) ?? []).length === 2);

  // scope
  ok("scope · existing seller_order_received / seller_order.cancelled senders untouched by 9F-32A",
    !/9F-32A/.test(notif.slice(notif.indexOf("export async function sendSellerOrderReceived"), notif.indexOf("export async function sendSellerOrderReceived") + 100)) &&
    /export async function sendSellerOrderCancelled\(/.test(notif));
  ok("scope · checkout / seller order-actions / cancellation NOT modified",
    !/9F-32A/.test(read("src/lib/checkout.ts")) &&
    !/9F-32A/.test(read("src/lib/seller/order-actions.ts")) &&
    !/9F-32A/.test(read("src/lib/marketplace/seller-order-repository.ts")));
  ok("scope · customer timeline (processingRungOverride) NOT modified",
    !/9F-32A/.test(read("src/lib/orders/status.ts")) && /processingRungOverride/.test(read("src/lib/orders/status.ts")));
  ok("scope · returns / settlements / offer status / seed-rbac untouched",
    !/9F-32A/.test(read("src/lib/admin/returns-actions.ts")) &&
    !/9F-32A/.test(read("src/lib/admin/settlement-actions.ts")) &&
    !/9F-32A/.test(read("scripts/seed-rbac.ts")));
  ok("scope · no schema change", !/9F-32A/.test(read("prisma/schema.prisma")));
}

// ── DB behaviour (rolled-back fixtures) ─────────────────────────────────
async function dbTests() {
  console.log("\n── the sweep (fixtures rolled back; injected `now`) ──");
  const category = await prisma.category.findFirst({ select: { id: true } });
  if (!category) { ok("(skipped — no category)", true); return; }
  const firstParty = await prisma.seller.findFirst({ where: { type: "FIRST_PARTY" }, select: { id: true } });
  const sfx = "9f32a-" + String(Date.now()).slice(-7);
  const NOW = new Date("2026-09-20T12:00:00Z");
  const ago = (ms: number) => new Date(NOW.getTime() - ms);

  const emailBefore = await prisma.emailLog.count();
  const auditBefore = await prisma.adminAuditLog.count();

  async function seedSeller(tx: Prisma.TransactionClient, withUser = true) {
    const seller = await tx.seller.create({
      data: { type: "THIRD_PARTY", status: "APPROVED", displayName: `S ${sfx}`, slug: `s-${sfx}-${Math.random().toString(36).slice(2, 6)}`, supportEmail: "s@t.test", notifyEmail: withUser ? `notify-${sfx}-${Math.random().toString(36).slice(2, 5)}@t.test` : null },
      select: { id: true },
    });
    if (withUser) {
      const u = await tx.user.create({ data: { email: `owner-${sfx}-${Math.random().toString(36).slice(2, 5)}@t.test`, name: "O" }, select: { id: true } });
      await tx.sellerUser.create({ data: { sellerId: seller.id, userId: u.id, role: "OWNER", status: "ACTIVE" } });
    }
    return seller.id;
  }
  async function seedOrder(
    tx: Prisma.TransactionClient,
    spec: { sellerId: string; sellerType?: string; soStatus?: string; parentStatus?: string; createdAt: Date },
  ) {
    const product = await tx.product.create({ data: { name: `P ${sfx}`, slug: `p-${sfx}-${Math.random().toString(36).slice(2, 7)}`, shortDescription: "s", description: "d", categoryId: category!.id, status: "ACTIVE", price: 1000 }, select: { id: true } });
    const order = await tx.order.create({
      data: { orderNumber: `AX-T32A-${sfx}-${Math.random().toString(36).slice(2, 5)}`, email: "b@e.test", phone: "+630", status: spec.parentStatus ?? "PROCESSING", paymentStatus: "PENDING", paymentMethod: "COD", subtotal: 1000, grandTotal: 1150, shippingFee: 150, shippingAddress: "{}", placedAt: spec.createdAt },
      select: { id: true, orderNumber: true },
    });
    const so = await tx.sellerOrder.create({
      data: { orderId: order.id, sellerId: spec.sellerId, sellerName: "S", sellerType: spec.sellerType ?? "THIRD_PARTY", supportEmail: "s@t.test", merchandiseSubtotal: 1000, shippingFee: 150, total: 1150, status: spec.soStatus ?? "PENDING_PAYMENT", createdAt: spec.createdAt },
      select: { id: true },
    });
    await tx.orderItem.create({ data: { orderId: order.id, sellerOrderId: so.id, sellerId: spec.sellerId, productId: product.id, name: "Item", unitPrice: 1000, quantity: 1, lineTotal: 1000 } });
    return { orderId: order.id, orderNumber: order.orderNumber, sellerOrderId: so.id };
  }

  try {
    await prisma.$transaction(async (tx) => {
      const S = await seedSeller(tx, true);
      const collected: Array<() => Promise<unknown>> = [];
      const run = (opts?: { now?: Date }) =>
        runSellerOrderAcceptanceSla({ client: tx, now: opts?.now ?? NOW, dispatch: (fn) => collected.push(fn) });

      // ── fixtures at various ages / states ──────────────────────────────
      const young = await seedOrder(tx, { sellerId: S, createdAt: ago(2 * HOUR) });      // < 4h
      const due = await seedOrder(tx, { sellerId: S, createdAt: ago(6 * HOUR) });         // 4h..24h
      const overdue = await seedOrder(tx, { sellerId: S, createdAt: ago(30 * HOUR) });    // > 24h
      const accepted = await seedOrder(tx, { sellerId: S, soStatus: "PROCESSING", createdAt: ago(10 * HOUR) }); // seller accepted
      const cancelledParent = await seedOrder(tx, { sellerId: S, parentStatus: "CANCELLED", createdAt: ago(10 * HOUR) });
      const shippedSo = await seedOrder(tx, { sellerId: S, soStatus: "SHIPPED", parentStatus: "SHIPPED", createdAt: ago(30 * HOUR) });
      const fp = firstParty ? await seedOrder(tx, { sellerId: firstParty.id, sellerType: "FIRST_PARTY", createdAt: ago(30 * HOUR) }) : null;

      // ── run 1 ─────────────────────────────────────────────────────────
      // NOTE: the sweep sees ALL SellerOrders, incl. any genuine stale prod
      // order (e.g. AX-260907-100389, unaccepted since Sep 8) — everything here
      // rolls back, so assert on the fixture rows, not global counts.
      const r1 = await run();
      const mine = (ids: string[], id: string) => ids.includes(id);
      ok("scan · picks up at least the 3 fixture candidates (young/due/overdue) — all THIRD_PARTY PENDING_PAYMENT on a PROCESSING parent",
        r1.scanned >= 3, JSON.stringify(r1));
      ok("young (< 4h) · no reminder", !mine(r1.reminded, young.sellerOrderId));
      ok("due (4h..24h) · reminder scheduled, NOT escalated",
        r1.reminded.includes(due.sellerOrderId) && !r1.escalated.includes(due.sellerOrderId));
      ok("overdue (> 24h) · reminder scheduled AND escalated", r1.reminded.includes(overdue.sellerOrderId) && r1.escalated.includes(overdue.sellerOrderId));
      ok("accepted (SellerOrder PROCESSING) · not scanned, no notification", !r1.reminded.includes(accepted.sellerOrderId) && !r1.escalated.includes(accepted.sellerOrderId));
      ok("parent CANCELLED · not scanned", !r1.reminded.includes(cancelledParent.sellerOrderId));
      ok("SellerOrder SHIPPED / parent SHIPPED · not scanned", !r1.reminded.includes(shippedSo.sellerOrderId));
      if (fp) ok("FIRST_PARTY · not scanned, no notification", !r1.reminded.includes(fp.sellerOrderId) && !r1.escalated.includes(fp.sellerOrderId));

      ok("audit · exactly ONE seller_order.acceptance_overdue row for the overdue fixture SellerOrder",
        (await tx.adminAuditLog.count({ where: { action: "seller_order.acceptance_overdue", targetId: overdue.sellerOrderId } })) === 1);
      ok("audit · NONE for the 'due' fixture (< 24h) or the 'young' fixture",
        (await tx.adminAuditLog.count({ where: { action: "seller_order.acceptance_overdue", targetId: { in: [due.sellerOrderId, young.sellerOrderId] } } })) === 0);
      const aud = await tx.adminAuditLog.findFirstOrThrow({ where: { action: "seller_order.acceptance_overdue", targetId: overdue.sellerOrderId }, select: { meta: true, actorUserId: true } });
      const m = JSON.parse(aud.meta) as Record<string, unknown>;
      ok("audit · meta has seller, orderNumber, status, wait, threshold; actor is the system (null)",
        aud.actorUserId === null && m.sellerId === S && typeof m.orderNumber === "string" && m.sellerOrderStatus === "PENDING_PAYMENT" && typeof m.waitedMs === "number" && m.escalationThresholdMs === 24 * HOUR);

      // fire the collected emails against the tx so EmailLog rows exist
      for (const fn of collected.splice(0)) await fn();
      ok("email · one reminder row (SKIPPED, no SMTP) for 'due'",
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_REMINDER:${due.sellerOrderId}`, type: "seller_order_acceptance_reminder" } })) === 1);
      ok("email · reminder recipient = the seller's OWNER user + notifyEmail",
        /owner-9f32a|notify-9f32a/i.test((await tx.emailLog.findFirstOrThrow({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_REMINDER:${due.sellerOrderId}` }, select: { recipient: true } })).recipient));
      ok("email · one overdue-ops row for 'overdue', recipient = support inbox",
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_OVERDUE:${overdue.sellerOrderId}`, type: "seller_order_acceptance_overdue_ops" } })) === 1 &&
        !/owner-9f32a|notify-9f32a/i.test((await tx.emailLog.findFirstOrThrow({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_OVERDUE:${overdue.sellerOrderId}` }, select: { recipient: true } })).recipient));

      // ── run 2 (idempotency) ───────────────────────────────────────────
      const r2 = await run();
      ok("idem · re-run does NOT re-schedule a reminder for 'due' (EmailLog row exists)", !r2.reminded.includes(due.sellerOrderId));
      ok("idem · re-run does NOT re-escalate 'overdue' (audit row exists)", !r2.escalated.includes(overdue.sellerOrderId));
      ok("idem · still exactly one reminder row + one overdue row + one audit row (fixture-scoped)",
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_REMINDER:${due.sellerOrderId}` } })) === 1 &&
        (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_OVERDUE:${overdue.sellerOrderId}` } })) === 1 &&
        (await tx.adminAuditLog.count({ where: { action: "seller_order.acceptance_overdue", targetId: overdue.sellerOrderId } })) === 1);

      // ── state re-check: seller accepts between scan and send ───────────
      {
        const late = await seedOrder(tx, { sellerId: S, createdAt: ago(6 * HOUR) });
        const rr = await runSellerOrderAcceptanceSla({ client: tx, now: NOW, dispatch: (fn) => collected.push(fn) });
        ok("recheck · 'late' picked up as a reminder candidate", rr.reminded.includes(late.sellerOrderId));
        // seller accepts NOW, before the queued email fires
        await tx.sellerOrder.updateMany({ where: { id: late.sellerOrderId }, data: { status: "PROCESSING" } });
        const res = await sendSellerOrderAcceptanceReminder(late.sellerOrderId, { client: tx, now: NOW });
        ok("recheck · the reminder sender SKIPs once the seller has accepted (status no longer PENDING_PAYMENT)", res.status === "SKIPPED" && res.ok === true);
        ok("recheck · no reminder EmailLog row was written for the since-accepted order",
          (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_REMINDER:${late.sellerOrderId}` } })) === 0);
        collected.splice(0);
      }

      // ── FIRST_PARTY sender guard ──────────────────────────────────────
      if (fp) {
        const res = await sendSellerOrderAcceptanceReminder(fp.sellerOrderId, { client: tx, now: NOW });
        ok("FIRST_PARTY · reminder sender SKIPs, no EmailLog row",
          res.status === "SKIPPED" && (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ORDER_ACCEPTANCE_REMINDER:${fp.sellerOrderId}` } })) === 0);
      }

      // ── overdue sender guard: below escalation threshold ──────────────
      {
        const res = await sendSellerOrderAcceptanceOverdueOps(due.sellerOrderId, { client: tx, now: NOW });
        ok("overdue sender · SKIPs a SellerOrder that is only 'due' (< 24h)", res.status === "SKIPPED");
      }

      throw new Rollback();
    }, { timeout: 120000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("ROLLBACK · no EmailLog leaked", (await prisma.emailLog.count()) === emailBefore);
  ok("ROLLBACK · no AdminAuditLog leaked", (await prisma.adminAuditLog.count()) === auditBefore);
  ok("ROLLBACK · no fixture order leaked", (await prisma.order.count({ where: { orderNumber: { contains: sfx } } })) === 0);
}

async function main() {
  console.log("\nPHASE 9F-32A — 3P seller-order acceptance SLA\n");
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
