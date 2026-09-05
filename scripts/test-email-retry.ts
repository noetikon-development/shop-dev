/**
 * Phase 9F-5c.1 — seller product-request email retry.
 *
 * DB tests build a seller + OWNER user + a plain customer user + an APPROVED /
 * REJECTED / DRAFT SellerProductRequest + a SKIPPED EmailLog row inside ONE
 * prisma.$transaction and roll back. `retryEmailByLog`, the three seller senders,
 * `loadSellerRequestEmailContext` and `dispatchEmail` all take an optional
 * transaction client so nothing leaks. The local env has no EMAIL_* creds, so a
 * "successful" retry re-records SKIPPED (not SENT) — the assertion is that the
 * retry ROUTES and REUSES the row, which in a configured runtime would send.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-email-retry.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { retryEmailByLog } from "../src/lib/email/notifications";

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

const D = new Date("2026-09-04T10:57:24.971Z"); // fixed reviewedAt for deterministic keys

async function seedSeller(tx: Tx, slug: string) {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status: "APPROVED", displayName: slug, slug, supportEmail: `${slug}@t.test`, contentStatus: "DRAFT" },
    select: { id: true },
  });
}
async function seedUser(tx: Tx, tag: string) {
  return tx.user.create({
    data: { email: `${tag}@t.test`, name: "T", role: "CUSTOMER", supabaseUserId: `sb-${tag}` },
    select: { id: true, email: true },
  });
}
async function seedEmailLog(tx: Tx, key: string, type: string, recipient: string) {
  return tx.emailLog.create({
    data: {
      type, recipient, subject: "(pending)", idempotencyKey: key,
      status: "SKIPPED", provider: "smtp", error: "smtp_not_configured", attempts: 0,
    },
    select: { id: true, idempotencyKey: true },
  });
}

async function dbTests() {
  const category = await prisma.category.findFirst({ where: { active: true }, select: { id: true } });
  if (!category) { ok("db tests skipped — no category", true); return; }
  const emailLogBefore = await prisma.emailLog.count();

  try {
    await prisma.$transaction(async (tx) => {
      const t = Date.now().toString(36);
      const S = await seedSeller(tx, `mr-${t}`);
      const owner = await seedUser(tx, `owner-${t}`);
      const customer = await seedUser(tx, `cust-${t}`); // NOT a SellerUser
      await tx.sellerUser.create({ data: { sellerId: S.id, userId: owner.id, role: "OWNER", status: "ACTIVE" } });

      // canonical product + 1 ACTIVE variant for the "create listing" link
      const product = await tx.product.create({
        data: { name: `MR ${t}`, slug: `mr-${t}`, shortDescription: "s", description: "d", categoryId: category.id, status: "DRAFT", price: 100000 },
        select: { id: true },
      });
      await tx.variant.create({
        data: { productId: product.id, sku: `MR-${t}`, price: 100000, status: "ACTIVE", stock: 0 },
      });

      // ── APPROVED (created) ────────────────────────────────────────────────
      const rApproved = await tx.sellerProductRequest.create({
        data: {
          sellerId: S.id, status: "APPROVED", proposedName: `Widget ${t}`, proposedCategoryId: category.id,
          submittedAt: D, reviewedAt: D, reviewedById: "admin-x", resultProductId: product.id,
          reviewStatusNote: "Added to the catalogue.",
          proposedVariants: { options: [], variants: [{ label: "Default" }] },
        },
        select: { id: true },
      });
      await tx.adminAuditLog.create({
        data: { action: "seller_product_request.product_created", targetType: "seller_product_request", targetId: rApproved.id, summary: "x", meta: "{}" },
      });
      const keyApproved = `SELLER_PRODUCT_REQUEST_APPROVED:${rApproved.id}:${D.getTime()}`;
      const eApproved = await seedEmailLog(tx, keyApproved, "seller_product_request_approved", owner.email);

      // 3/4 — routed, not "not_retryable"
      const r1 = await retryEmailByLog(eApproved.id, tx);
      ok("4 · seller_product_request_approved retry ROUTES (not not_retryable)", r1.error !== "not_retryable", JSON.stringify(r1));
      ok("2 · SKIPPED + smtp_not_configured retry reaches the dispatch retry branch (status SKIPPED, not DEDUPED)", r1.status === "SKIPPED", JSON.stringify(r1));

      const rowsForKey = await tx.emailLog.findMany({ where: { idempotencyKey: keyApproved }, select: { id: true, recipient: true, subject: true, idempotencyKey: true, status: true } });
      ok("7/8 · exactly one EmailLog row for the key — the same row reused, no duplicate", rowsForKey.length === 1 && rowsForKey[0].id === eApproved.id);
      ok("11 · idempotency key preserved", rowsForKey[0].idempotencyKey === keyApproved);
      ok("12 · recipient is the seller OWNER", rowsForKey[0].recipient.includes(owner.email));
      ok("13 · recipient never includes the plain customer", !rowsForKey[0].recipient.includes(customer.email));
      ok("14 · email rendered (real subject, not the render-failure placeholder)", rowsForKey[0].subject === `Approved: Widget ${t}` );

      // 9 — same retry clicked twice → still one row
      const r2 = await retryEmailByLog(eApproved.id, tx);
      ok("9 · second retry is safe (SKIPPED again or DEDUPED, no new row)", ["SKIPPED", "DEDUPED"].includes(r2.status));
      ok("9 · still exactly one row for the key", (await tx.emailLog.count({ where: { idempotencyKey: keyApproved } })) === 1);

      // 10 — concurrent retry
      const [c1, c2] = await Promise.all([retryEmailByLog(eApproved.id, tx), retryEmailByLog(eApproved.id, tx)]);
      ok("10 · concurrent retry is safe (both resolve, no throw)", Boolean(c1) && Boolean(c2));
      ok("10 · concurrent retry leaves exactly one row", (await tx.emailLog.count({ where: { idempotencyKey: keyApproved } })) === 1);

      // ── APPROVED (linked) — linked=true derived from the .linked audit row ─
      const rLinked = await tx.sellerProductRequest.create({
        data: { sellerId: S.id, status: "APPROVED", proposedName: `Linked ${t}`, submittedAt: D, reviewedAt: D, reviewedById: "admin-x", resultProductId: product.id, proposedVariants: { options: [], variants: [{ label: "Default" }] } },
        select: { id: true },
      });
      await tx.adminAuditLog.create({ data: { action: "seller_product_request.linked", targetType: "seller_product_request", targetId: rLinked.id, summary: "x", meta: "{}" } });
      const keyLinked = `SELLER_PRODUCT_REQUEST_APPROVED:${rLinked.id}:${D.getTime()}`;
      const eLinked = await seedEmailLog(tx, keyLinked, "seller_product_request_approved", owner.email);
      const rl = await retryEmailByLog(eLinked.id, tx);
      ok("4 · linked-approval retry routes + renders", rl.error !== "not_retryable" && rl.status === "SKIPPED");
      const linkedRow = await tx.emailLog.findFirstOrThrow({ where: { idempotencyKey: keyLinked }, select: { subject: true } });
      ok("4 · linked-approval subject rendered", linkedRow.subject === `Approved: Linked ${t}`);

      // ── REJECTED ─────────────────────────────────────────────────────────
      const rRej = await tx.sellerProductRequest.create({
        data: { sellerId: S.id, status: "REJECTED", proposedName: `Rej ${t}`, submittedAt: D, reviewedAt: D, reviewedById: "admin-x", reviewStatusNote: "no", proposedVariants: { options: [], variants: [{ label: "Default" }] } },
        select: { id: true },
      });
      const keyRej = `SELLER_PRODUCT_REQUEST_REJECTED:${rRej.id}:rejected:${D.getTime()}`;
      const eRej = await seedEmailLog(tx, keyRej, "seller_product_request_rejected", owner.email);
      const rr = await retryEmailByLog(eRej.id, tx);
      ok("5 · seller_product_request_rejected retry routes", rr.error !== "not_retryable" && rr.status === "SKIPPED");
      ok("5 · rejected row reused, key preserved", (await tx.emailLog.count({ where: { idempotencyKey: keyRej } })) === 1);
      const rejRow = await tx.emailLog.findFirstOrThrow({ where: { idempotencyKey: keyRej }, select: { subject: true } });
      ok("5 · rejected subject rendered (outcome from key)", rejRow.subject === `Not approved: Rej ${t}`);

      // ── CHANGES REQUESTED (status DRAFT, outcome in key) ─────────────────
      const rChg = await tx.sellerProductRequest.create({
        data: { sellerId: S.id, status: "DRAFT", proposedName: `Chg ${t}`, submittedAt: D, reviewedAt: D, reviewedById: "admin-x", reviewStatusNote: "please fix", proposedVariants: { options: [], variants: [{ label: "Default" }] } },
        select: { id: true },
      });
      const keyChg = `SELLER_PRODUCT_REQUEST_REJECTED:${rChg.id}:changes_requested:${D.getTime()}`;
      const eChg = await seedEmailLog(tx, keyChg, "seller_product_request_rejected", owner.email);
      const rc = await retryEmailByLog(eChg.id, tx);
      ok("5 · changes-requested retry routes", rc.error !== "not_retryable" && rc.status === "SKIPPED");
      const chgRow = await tx.emailLog.findFirstOrThrow({ where: { idempotencyKey: keyChg }, select: { subject: true } });
      ok("5 · changes-requested subject rendered (outcome parsed from key)", chgRow.subject === `Changes needed: Chg ${t}`);

      // ── SUBMITTED ───────────────────────────────────────────────────────
      const rSub = await tx.sellerProductRequest.create({
        data: { sellerId: S.id, status: "PENDING", proposedName: `Sub ${t}`, submittedAt: D, proposedVariants: { options: [], variants: [{ label: "Default" }] } },
        select: { id: true },
      });
      const keySub = `SELLER_PRODUCT_REQUEST_SUBMITTED:${rSub.id}`;
      const eSub = await seedEmailLog(tx, keySub, "seller_product_request_submitted", owner.email);
      const rs = await retryEmailByLog(eSub.id, tx);
      ok("3 · seller_product_request_submitted retry routes", rs.error !== "not_retryable" && rs.status === "SKIPPED");
      ok("3 · submitted row reused, key preserved", (await tx.emailLog.count({ where: { idempotencyKey: keySub } })) === 1);

      // ── 6 — an unsupported SKIPPED type stays not_retryable ──────────────
      const eOther = await seedEmailLog(tx, `PASSWORD_CHANGED:u-${t}:2026-09-04T10`, "password_changed", owner.email);
      const ro = await retryEmailByLog(eOther.id, tx);
      ok("6 · unsupported SKIPPED type (password_changed) → not_retryable", ro.ok === false && ro.error === "not_retryable");
      ok("6 · not_retryable is a no-op (row untouched, still 1)", (await tx.emailLog.count({ where: { id: eOther.id } })) === 1);

      // 1 — the existing FAILED order/welcome/payment retry routing is
      // asserted statically (see staticTests): those sender fns are NOT
      // transaction-client-aware, so running them here would write a real
      // EmailLog row. The switch cases for them are byte-unchanged.

      // 15 — SENT row short-circuits to DEDUPED (unchanged behaviour)
      const eSent = await tx.emailLog.create({
        data: { type: "seller_product_request_approved", recipient: owner.email, subject: "x", idempotencyKey: `SELLER_PRODUCT_REQUEST_APPROVED:${rApproved.id}:999`, status: "SENT", sentAt: D },
        select: { id: true },
      });
      const rSent = await retryEmailByLog(eSent.id, tx);
      ok("15 · a SENT row retry → DEDUPED (never re-sends)", rSent.status === "DEDUPED");

      throw new Rollback();
    }, { timeout: 40_000, maxWait: 12_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }

  ok("isolation · EmailLog count unchanged after rollback", (await prisma.emailLog.count()) === emailLogBefore, `${emailLogBefore} vs ${await prisma.emailLog.count()}`);
}

function staticTests() {
  const notifs = read("src/lib/email/notifications.ts");
  const send = read("src/lib/email/send.ts");
  const adminActions = read("src/lib/admin/seller-product-requests/actions.ts");
  const schema = read("prisma/schema.prisma");

  // routing cases exist
  ok("routing · retryEmailByLog has the 3 seller_product_request cases", /case "seller_product_request_submitted":[\s\S]{0,400}case "seller_product_request_approved":[\s\S]{0,80}case "seller_product_request_rejected":/.test(notifs));
  ok("routing · original order/welcome/payment cases unchanged", /case "order_confirmation":[\s\S]*case "welcome":[\s\S]*case "payment_confirmation":/.test(notifs));
  // Budget widened (400 -> 700 chars) for 9F-7b's longer default-branch
  // comment (documents that the new _ops companions ARE retryable, unlike
  // their sibling customer-facing types) — the retry semantics are unchanged.
  ok("routing · default branch still returns not_retryable", /\n\s*default:\s*\n[\s\S]{0,700}?error: "not_retryable"/.test(notifs) && (notifs.match(/error: "not_retryable"/g) ?? []).length === 1);
  ok("routing · request id comes from the idempotency key, outcome from the key too", /log\.idempotencyKey\.split\(":"\)/.test(notifs) && /parts\[2\] === "changes_requested"/.test(notifs));
  ok("routing · retry passes the ORIGINAL key back (row reuse)", /idempotencyKey: log\.idempotencyKey/.test(notifs));

  // senders thread retry + accept an override key
  ok("senders · accept { retry?, idempotencyKey?, client? }", /type SellerRequestEmailOpts = \{[\s\S]{0,200}retry\?: boolean;[\s\S]{0,200}idempotencyKey\?: string;/.test(notifs));
  ok("senders · thread retry into renderAndDispatch meta", (notifs.match(/retry: opts\.retry/g) ?? []).length >= 3);
  // >= 3 rather than === 3: 9F-6b (scripts/test-9f6b.ts) added 6 more senders
  // using the identical `opts.idempotencyKey ??` override pattern.
  ok("senders · use the override key when given (opts.idempotencyKey ??)", (notifs.match(/opts\.idempotencyKey \?\?/g) ?? []).length >= 3);
  ok("senders · reconstruct linked-vs-added from the audit log (no event data passed in)", /action: "seller_product_request\.linked"/.test(notifs));
  ok("senders · derive reviewedAt from the request row", /ctx\.reviewedAt \?\? new Date\(\)/.test(notifs));

  // dispatch retry semantics unchanged, still gated on configured SMTP
  ok("dispatch · retry reuses the row for a FAILED/SKIPPED key", /if \(!input\.retry\) return \{ ok: true, deduped: true/.test(send) && /\["SENT", "SENDING", "PENDING"\]\.includes\(existing\.status\)/.test(send));
  ok("dispatch · real send still gated on cfg.configured", /if \(!cfg\.configured \|\| !transport\)/.test(send) && /transport\.sendMail\(/.test(send));
  ok("dispatch · EmailLog client is opt-in and defaults to the module client", /const db: LogClient = input\.client \?\? prisma/.test(send));

  // call sites simplified (no event data duplicated)
  ok("call sites · admin actions no longer pass reviewedAt / linked / outcome / listUrl", !/sendSellerProductRequest\w+\([^)]*reviewedAt|sendSellerProductRequest\w+\([^)]*linked:|sendSellerProductRequest\w+\([^)]*outcome:/.test(adminActions));

  // 5 / 6 — no schema change, no unrelated retry-type change
  const emailLogBlock = schema.slice(schema.indexOf("model EmailLog {"), schema.indexOf("model EmailLog {") + 1400);
  ok("schema · EmailLog model has no requestId / sellerProductRequest / new relation", !/requestId|sellerProductRequest|SellerProductRequest/.test(emailLogBlock));
  ok("schema · EmailLog keeps its shape (idempotencyKey @unique, attempts, userId/orderId FKs only)", /idempotencyKey\s+String\s+@unique/.test(emailLogBlock) && /attempts\s+Int\s+@default\(0\)/.test(emailLogBlock) && /user\s+User\?/.test(emailLogBlock) && /order\s+Order\?/.test(emailLogBlock));
}

async function main() {
  console.log("\nPHASE 9F-5c.1 — seller product-request email retry\n");
  console.log("Static wiring");
  staticTests();
  console.log("\nDatabase (rolled back)");
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
