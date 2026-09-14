/**
 * PHASE 9F-57 — CMS customization layer for the 3P seller / PayMongo email
 * notification framework.
 *
 * Reuses the existing `ContentBlock` CMS (one row per template, `area:"email"`,
 * `type:"email_template"`, key `email.<templateKey>`) and the existing
 * dispatchEmail() / EmailLog / idempotency / failEmailPreparation
 * infrastructure — no second email framework, no new Prisma model.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-9f57.ts
 */
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  getEmailTemplateOverride,
  substituteTokens,
  renderEmailTemplateOverride,
  genericFallbackFor,
  MissingReasonError,
} from "../src/lib/email/template-overrides";
import {
  EMAIL_TEMPLATES,
  EMAIL_TOKENS,
  getEmailTemplateDef,
  isEmailTemplateKey,
  emailTemplateBlockKey,
} from "../src/lib/email/template-registry";
import { emailTemplateSchema } from "../src/lib/content-blocks";
import {
  sendSellerAccountApproved,
  sendSellerAccountRejected,
  sendSellerAccountSubmitted,
  sendPaymentConfirmation,
  sendPaymentFailed,
} from "../src/lib/email/notifications";

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

// ---------------------------------------------------------------------------
// 1 — registry sanity (every template from the task's checklist is covered)
// ---------------------------------------------------------------------------

function registryTests() {
  console.log("\n── 1 · template registry ──");
  const REQUIRED_KEYS = [
    "seller_account_submitted", "seller_account_approved", "seller_account_rejected", "seller_account_reopened",
    "seller_product_request_submitted", "seller_product_request_approved", "seller_product_request_rejected",
    "seller_product_request_changes_requested", "seller_product_request_resubmitted_ops",
    "seller_order_received", "seller_order_accepted", "seller_order_acceptance_reminder",
    "seller_order_acceptance_overdue_ops", "seller_order_ready_to_ship", "seller_shipment_created",
    "seller_order_shipped", "seller_order_delivered",
    "seller_order_cancelled", "seller_return_requested", "seller_return_approved", "seller_return_rejected",
    "seller_refund_notice", "seller_settlement_recorded",
    "payment_confirmation", "payment_failed", "payment_expired_or_cancelled", "refund_completed",
  ];
  for (const k of REQUIRED_KEYS) {
    ok(`1 · registry includes "${k}"`, isEmailTemplateKey(k), k);
  }
  ok("1 · no duplicate keys", new Set(EMAIL_TEMPLATES.map((d) => d.key)).size === EMAIL_TEMPLATES.length);
  ok("1 · every template allows storeName", EMAIL_TEMPLATES.every((d) => d.allowedTokens.includes("storeName")));
  ok("1 · every allowedToken is a real EMAIL_TOKEN", EMAIL_TEMPLATES.every((d) => d.allowedTokens.every((t) => (EMAIL_TOKENS as readonly string[]).includes(t))));
  for (const k of ["seller_account_rejected", "seller_account_reopened", "seller_product_request_rejected", "seller_product_request_changes_requested", "seller_return_rejected"]) {
    const def = getEmailTemplateDef(k)!;
    ok(`1 · "${k}" is marked requiresReason + allows {{reason}}`, def.requiresReason === true && def.allowedTokens.includes("reason"));
  }
  ok("1 · emailTemplateBlockKey is stable + namespaced", emailTemplateBlockKey("seller_account_approved") === "email.seller_account_approved");
}

// ---------------------------------------------------------------------------
// 2 — pure: token substitution
// ---------------------------------------------------------------------------

function tokenSubstitutionTests() {
  console.log("\n── 2 · token substitution ──");
  const allowed = ["sellerName", "orderNumber"] as const;
  ok("2 · substitutes an allowed token", substituteTokens("Hi {{sellerName}}", allowed, { sellerName: "Acme" }) === "Hi Acme");
  ok("2 · substitutes multiple allowed tokens", substituteTokens("{{sellerName}} / {{orderNumber}}", allowed, { sellerName: "Acme", orderNumber: "AX-1" }) === "Acme / AX-1");
  ok("2 · a token NOT in the allowed set is left literal, never breaks", substituteTokens("{{reason}} stays as-is", allowed, { reason: "should not appear" }) === "{{reason}} stays as-is");
  ok("2 · a nonsense/typo token is left literal, never breaks", substituteTokens("{{totallyUnknownXyz}}", allowed, {}) === "{{totallyUnknownXyz}}");
  ok("2 · an allowed token with no supplied value substitutes to empty, never 'undefined'", substituteTokens("[{{orderNumber}}]", allowed, {}) === "[]");
  ok("2 · plain text with no tokens passes through unchanged", substituteTokens("plain text", allowed, {}) === "plain text");
  ok("2 · empty string input returns empty string", substituteTokens("", allowed, {}) === "");
}

// ---------------------------------------------------------------------------
// 3 — pure: renderEmailTemplateOverride (custom subject/heading/body, mixed
// blank-field fallback, escaping, reason authority)
// ---------------------------------------------------------------------------

function renderOverrideTests() {
  console.log("\n── 3 · renderEmailTemplateOverride ──");

  // 3a — full custom copy + token substitution
  {
    const r = renderEmailTemplateOverride({
      templateKey: "seller_account_approved",
      override: { subject: "Welcome, {{sellerName}}!", heading: "You're in, {{sellerName}}", body: "Go here: {{actionUrl}}", extraMessage: "", actionLabel: "Go" },
      brand: "Axiaro",
      siteUrl: "https://axiaro.shop",
      tokenValues: { sellerName: "Acme Co", storeName: "Axiaro", actionUrl: "https://axiaro.shop/seller" },
      fallback: genericFallbackFor("seller_account_approved"),
      actionUrl: "https://axiaro.shop/seller",
    });
    ok("3a · custom subject is used + tokens substituted", r.subject === "Welcome, Acme Co!");
    ok("3a · custom heading is used + tokens substituted", r.html.includes("You&#39;re in, Acme Co") || r.html.includes("You're in, Acme Co"));
    ok("3a · custom body is used + actionUrl substituted", r.text.includes("Go here: https://axiaro.shop/seller"));
    ok("3a · action button rendered with the custom label", r.html.includes(">Go<") && r.html.includes("https://axiaro.shop/seller"));
  }

  // 3b — partial override: blank fields fall back to the generic per-template default
  {
    const fallback = genericFallbackFor("seller_account_approved");
    const r = renderEmailTemplateOverride({
      templateKey: "seller_account_approved",
      override: { subject: "Custom subject only", heading: "", body: "", extraMessage: "", actionLabel: "" },
      brand: "Axiaro",
      siteUrl: "https://axiaro.shop",
      tokenValues: { sellerName: "Acme Co" },
      fallback,
      actionUrl: "https://axiaro.shop/seller",
    });
    ok("3b · a blank field falls back to the generic default, not empty", r.subject === "Custom subject only" && r.text.includes(fallback.body));
  }

  // 3c — an unrecognized/unsupported token in custom text never breaks rendering
  {
    const r = renderEmailTemplateOverride({
      templateKey: "seller_account_approved",
      override: { subject: "Hi {{notAToken}}", heading: "H", body: "B {{alsoNotAToken}}", extraMessage: "", actionLabel: "" },
      brand: "Axiaro",
      siteUrl: "https://axiaro.shop",
      tokenValues: { sellerName: "Acme Co" },
      fallback: genericFallbackFor("seller_account_approved"),
      actionUrl: null,
    });
    ok("3c · unknown tokens are left literal, rendering completes without throwing", r.subject === "Hi {{notAToken}}" && r.text.includes("B {{alsoNotAToken}}"));
  }

  // 3d — REJECTION RULE: the CMS body does NOT mention {{reason}} at all, but
  // the real reason is STILL shown verbatim in its own box, and CMS text can
  // never replace it.
  {
    const REAL_REASON = "Business registration could not be verified.";
    const r = renderEmailTemplateOverride({
      templateKey: "seller_account_rejected",
      override: { subject: "An update on your application", heading: "Update", body: "Please see below for more information.", extraMessage: "", actionLabel: "" },
      brand: "Axiaro",
      siteUrl: "https://axiaro.shop",
      tokenValues: { sellerName: "Acme Co", reason: REAL_REASON },
      fallback: genericFallbackFor("seller_account_rejected"),
      actionUrl: null,
    });
    ok("3d · the ACTUAL runtime reason appears verbatim even though the CMS body never referenced {{reason}}", r.text.includes(REAL_REASON) && r.html.includes(REAL_REASON));
    ok("3d · the CMS body text is ALSO present (both coexist — CMS wraps, never replaces, the reason)", r.text.includes("Please see below for more information."));
  }

  // 3e — REJECTION RULE, impossible state: a reason-required template rendered
  // with NO reason value must throw MissingReasonError, never invent text.
  {
    let threw: unknown = null;
    try {
      renderEmailTemplateOverride({
        templateKey: "seller_account_rejected",
        override: { subject: "s", heading: "h", body: "b", extraMessage: "", actionLabel: "" },
        brand: "Axiaro",
        siteUrl: "https://axiaro.shop",
        tokenValues: { sellerName: "Acme Co" }, // no reason
        fallback: genericFallbackFor("seller_account_rejected"),
        actionUrl: null,
      });
    } catch (e) {
      threw = e;
    }
    ok("3e · rendering a requiresReason template with NO reason throws MissingReasonError (never invents one)", threw instanceof MissingReasonError);
  }

  // 3f — escaping: a malicious/HTML-bearing CMS field or token value never
  // injects markup or script into the rendered HTML.
  {
    const r = renderEmailTemplateOverride({
      templateKey: "seller_account_approved",
      override: { subject: "s", heading: "<script>alert(1)</script>", body: "{{sellerName}}", extraMessage: "", actionLabel: "" },
      brand: "Axiaro",
      siteUrl: "https://axiaro.shop",
      tokenValues: { sellerName: "<img src=x onerror=alert(2)>" },
      fallback: genericFallbackFor("seller_account_approved"),
      actionUrl: null,
    });
    ok("3f · a <script> tag in CMS text is escaped, never executable markup", !r.html.includes("<script>") && r.html.includes("&lt;script&gt;"));
    ok("3f · a token VALUE containing markup is also escaped", !r.html.includes("<img src=x") && r.html.includes("&lt;img"));
  }
}

// ---------------------------------------------------------------------------
// 4 — static wiring: renderAndDispatch's override branch, and every required
// sender threads templateKey/templateTokens through.
// ---------------------------------------------------------------------------

function staticWiringTests() {
  console.log("\n── 4 · static wiring ──");
  const notif = read("src/lib/email/notifications.ts");
  const contentBlocks = read("src/lib/content-blocks.ts");
  const actions = read("src/lib/admin/email-template-actions.ts");

  ok("4 · content-blocks.ts registers the email_template block type", /email_template: \{ label: "Email template"/.test(contentBlocks));
  ok("4 · CONTENT_AREAS includes \"email\"", /CONTENT_AREAS = \["homepage", "global", "email"\]/.test(contentBlocks));
  ok("4 · email_template is excluded from homepage-addable block types", /SITE_WIDE_BLOCK_TYPE_KEYS = \["footer", "navigation", "auth_artwork", "email_template"\]/.test(contentBlocks));

  ok("4 · renderAndDispatch checks meta.templateKey BEFORE the synchronous try/build", /if \(meta\.templateKey\) \{[\s\S]{0,400}getEmailTemplateOverride\(meta\.templateKey, meta\.client\)/.test(notif));
  ok("4 · no override → effectiveBuild stays the caller's own build (byte-identical default path)", /let effectiveBuild = build;/.test(notif));

  const REQUIRED_SENDER_TEMPLATE_KEYS: [string, string][] = [
    ["sendSellerAccountSubmitted", "seller_account_submitted"],
    ["sendSellerAccountApproved", "seller_account_approved"],
    ["sendSellerAccountRejected", "seller_account_rejected"],
    ["sendSellerAccountReopened", "seller_account_reopened"],
    ["sendSellerProductRequestSubmitted", "seller_product_request_submitted"],
    ["sendSellerProductRequestApproved", "seller_product_request_approved"],
    ["sendSellerProductRequestResubmittedOps", "seller_product_request_resubmitted_ops"],
    ["sendSellerOrderReceived", "seller_order_received"],
    ["sendSellerOrderAcceptanceReminder", "seller_order_acceptance_reminder"],
    ["sendSellerOrderAcceptanceOverdueOps", "seller_order_acceptance_overdue_ops"],
    ["sendSellerShipmentCreated", "seller_shipment_created"],
    ["sendSellerOrderCancelled", "seller_order_cancelled"],
    ["sendSellerReturnRequested", "seller_return_requested"],
    ["sendSellerReturnReceived", "seller_return_received"],
    ["sendSellerReturnApproved", "seller_return_approved"],
    ["sendSellerReturnRejected", "seller_return_rejected"],
    ["sendSellerRefundNotice", "seller_refund_notice"],
    ["sendSellerSettlementRecorded", "seller_settlement_recorded"],
    ["sendPaymentConfirmation", "payment_confirmation"],
    ["sendPaymentFailed", "payment_failed"],
    ["sendPaymentExpiredOrCancelled", "payment_expired_or_cancelled"],
    ["sendRefundCompleted", "refund_completed"],
  ];
  for (const [fn, key] of REQUIRED_SENDER_TEMPLATE_KEYS) {
    const start = notif.indexOf(`export async function ${fn}(`);
    ok(`4 · ${fn} exists`, start !== -1, fn);
    ok(`4 · ${fn} threads templateKey "${key}"`, notif.slice(start, start + 4000).includes(`templateKey: "${key}"`), fn);
  }
  // The two dynamic-key senders (outcome / milestone) are checked by value, not literal string.
  ok("4 · sendSellerProductRequestRejected picks templateKey by outcome (rejected vs changes_requested)",
    /const templateKey =\s*\n\s*outcome === "rejected" \? "seller_product_request_rejected" : "seller_product_request_changes_requested";/.test(notif));
  ok("4 · sendSellerOrderMilestone reuses SELLER_ORDER_MILESTONE_TYPE as the templateKey (already the matching names)",
    /templateKey: type,/.test(notif));

  ok("4 · saveEmailTemplateAction requires manage_content", /export async function saveEmailTemplateAction[\s\S]{0,200}requirePermission\("manage_content"\)/.test(actions));
  ok("4 · resetEmailTemplateAction requires manage_content", /export async function resetEmailTemplateAction[\s\S]{0,200}requirePermission\("manage_content"\)/.test(actions));
  {
    const previewStart = actions.indexOf("export async function previewEmailTemplateAction(");
    const previewBody = actions.slice(previewStart, actions.indexOf("\n}\n", previewStart));
    ok("4 · previewEmailTemplateAction requires manage_content but its body never calls dispatchEmail/renderAndDispatch",
      /requirePermission\("manage_content"\)/.test(previewBody) && !/dispatchEmail|renderAndDispatch/.test(previewBody));
  }
  ok("4 · saveEmailTemplateAction writes an audit row", /writeAudit\(\{[\s\S]{0,400}content\.email_template_/.test(actions));
  ok("4 · resetEmailTemplateAction writes an audit row", /content\.email_template_reset/.test(actions));
}

// ---------------------------------------------------------------------------
// 5 — DB (rolled back): default fallback, custom override, disabled fallback,
// reset-to-default, idempotency, durable failure on missing reason.
// ---------------------------------------------------------------------------

async function seedSeller(tx: Tx, tag: string, status = "APPROVED") {
  return tx.seller.create({
    data: { type: "THIRD_PARTY", status, displayName: `Seller ${tag}`, slug: `s9f57-${tag}-${Math.random().toString(36).slice(2, 7)}`, supportEmail: `support-${tag}@t.test`, contentStatus: "DRAFT" },
    select: { id: true, displayName: true, supportEmail: true },
  });
}
async function seedOwner(tx: Tx, sellerId: string, tag: string) {
  const email = `owner-${tag}@t.test`;
  const user = await tx.user.create({ data: { email, name: "Owner" }, select: { id: true } });
  await tx.sellerUser.create({ data: { sellerId, userId: user.id, role: "OWNER", status: "ACTIVE" } });
  return email;
}
async function seedAudit(tx: Tx, action: string, sellerId: string, meta: Record<string, unknown>) {
  return tx.adminAuditLog.create({ data: { action, targetType: "seller", targetId: sellerId, summary: "x", meta: JSON.stringify(meta) }, select: { id: true } });
}
async function seedTemplateOverride(tx: Tx, templateKey: string, data: Record<string, unknown>, status: "PUBLISHED" | "DRAFT" = "PUBLISHED") {
  const key = `email.${templateKey}`;
  // `key` is globally unique (one row per template, matching the real system) —
  // several sub-tests below reuse the same templateKey in sequence, so this
  // replaces any row a PRIOR sub-test left behind rather than colliding.
  return tx.contentBlock.upsert({
    where: { key },
    create: { key, area: "email", type: "email_template", data: JSON.stringify(data), status },
    update: { data: JSON.stringify(data), status },
    select: { id: true },
  });
}

async function dbTests() {
  console.log("\n── 5 · DB (rolled back) ──");
  try {
    await prisma.$transaction(async (tx) => {
      // 5a — CMS template retrieval: none exists → null (safe default path)
      const noneYet = await getEmailTemplateOverride("seller_account_approved", tx);
      ok("5a · getEmailTemplateOverride returns null when no row exists", noneYet === null);

      // 5b — default fallback end-to-end: sendSellerAccountApproved with NO
      // override renders through its OWN existing renderXxx() — subject is the
      // real app-default subject, byte-identical to pre-9F-57 behavior.
      const s1 = await seedSeller(tx, "b1");
      await seedOwner(tx, s1.id, "b1");
      const audit1 = await seedAudit(tx, "seller.approved", s1.id, { sellerId: s1.id, from: "PENDING", to: "APPROVED" });
      const r1 = await sendSellerAccountApproved(s1.id, audit1.id, { client: tx });
      ok("5b · default (no override) send succeeds", r1.ok === true, JSON.stringify(r1));
      const log1 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${s1.id}:${audit1.id}` }, select: { subject: true } });
      ok("5b · EmailLog subject is the real app default (not a CMS placeholder)", log1?.subject === `Your Axiaro seller account is approved`);

      // 5c — custom subject: publish an override with ONLY a custom subject →
      // the dispatched EmailLog.subject reflects it (per-field fallback keeps
      // heading/body from the generic default, but subject is exactly the CMS text).
      const s2 = await seedSeller(tx, "b2");
      await seedOwner(tx, s2.id, "b2");
      const audit2 = await seedAudit(tx, "seller.approved", s2.id, { sellerId: s2.id, from: "PENDING", to: "APPROVED" });
      await seedTemplateOverride(tx, "seller_account_approved", { subject: "Welcome aboard, {{sellerName}}!", heading: "", body: "", extraMessage: "", actionLabel: "" });
      const r2 = await sendSellerAccountApproved(s2.id, audit2.id, { client: tx });
      ok("5c · custom-subject send succeeds", r2.ok === true, JSON.stringify(r2));
      const log2 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${s2.id}:${audit2.id}` }, select: { subject: true } });
      ok("5c · EmailLog subject is the CUSTOM subject with {{sellerName}} substituted", log2?.subject === "Welcome aboard, Seller b2!");

      // 5d — custom heading/body: verify both independently override-able and
      // reach the actual dispatched content (subject here still customized).
      const s3 = await seedSeller(tx, "b3");
      await seedOwner(tx, s3.id, "b3");
      const audit3 = await seedAudit(tx, "seller.approved", s3.id, { sellerId: s3.id, from: "PENDING", to: "APPROVED" });
      await seedTemplateOverride(tx, "seller_account_approved", { subject: "Custom subject b3", heading: "Custom heading b3", body: "Custom body for {{sellerName}}.", extraMessage: "Extra note.", actionLabel: "Go now" });
      const r3 = await sendSellerAccountApproved(s3.id, audit3.id, { client: tx });
      ok("5d · custom heading/body send succeeds", r3.ok === true, JSON.stringify(r3));

      // 5e — disabled-template fallback: the SAME override exists but status
      // DRAFT → must behave exactly like "no override" (uses the app default).
      const s4 = await seedSeller(tx, "b4");
      await seedOwner(tx, s4.id, "b4");
      const audit4 = await seedAudit(tx, "seller.approved", s4.id, { sellerId: s4.id, from: "PENDING", to: "APPROVED" });
      await seedTemplateOverride(tx, "seller_account_approved", { subject: "SHOULD NOT APPEAR", heading: "", body: "", extraMessage: "", actionLabel: "" }, "DRAFT");
      const disabledLookup = await getEmailTemplateOverride("seller_account_approved", tx);
      ok("5e · a DRAFT (disabled) row resolves as null — falls back to default", disabledLookup === null);
      const r4 = await sendSellerAccountApproved(s4.id, audit4.id, { client: tx });
      const log4 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${s4.id}:${audit4.id}` }, select: { subject: true } });
      ok("5e · disabled override never reaches the dispatched email", r4.ok === true && log4?.subject === "Your Axiaro seller account is approved");

      // 5f — invalid/malformed template data → treated as no override
      const s5 = await seedSeller(tx, "b5");
      await seedOwner(tx, s5.id, "b5");
      const audit5 = await seedAudit(tx, "seller.approved", s5.id, { sellerId: s5.id, from: "PENDING", to: "APPROVED" });
      // b4's DRAFT row from 5e is still at this key — clear it first (the key is
      // globally unique, one row per template) before seeding the malformed one.
      await tx.contentBlock.deleteMany({ where: { key: "email.seller_account_approved" } });
      await tx.contentBlock.create({ data: { key: "email.seller_account_approved", area: "email", type: "email_template", data: "{not valid json", status: "PUBLISHED" } });
      const invalidLookup = await getEmailTemplateOverride("seller_account_approved", tx);
      ok("5f · malformed JSON payload resolves as null — falls back to default, never throws", invalidLookup === null);
      const r5 = await sendSellerAccountApproved(s5.id, audit5.id, { client: tx });
      ok("5f · send with a malformed override still succeeds using the app default", r5.ok === true, JSON.stringify(r5));
      await tx.contentBlock.deleteMany({ where: { key: "email.seller_account_approved" } });

      // 5g — reset-to-default is exactly "the row no longer exists": simulate
      // by creating then deleting (the action itself is exercised statically
      // above; this proves the RESOLVER treats "deleted" identically to "never customized").
      const resetKeyRow = await seedTemplateOverride(tx, "seller_account_approved", { subject: "temp", heading: "", body: "", extraMessage: "", actionLabel: "" });
      ok("5g · override exists before reset", (await getEmailTemplateOverride("seller_account_approved", tx)) !== null);
      await tx.contentBlock.delete({ where: { id: resetKeyRow.id } });
      ok("5g · after deleting the row (= reset), resolver returns null again", (await getEmailTemplateOverride("seller_account_approved", tx)) === null);

      // 5h — idempotency UNCHANGED with an override active: duplicate call → deduped, still one row
      const s6 = await seedSeller(tx, "b6");
      await seedOwner(tx, s6.id, "b6");
      const audit6 = await seedAudit(tx, "seller.approved", s6.id, { sellerId: s6.id, from: "PENDING", to: "APPROVED" });
      await seedTemplateOverride(tx, "seller_account_approved", { subject: "Idempotency check", heading: "", body: "", extraMessage: "", actionLabel: "" });
      const r6a = await sendSellerAccountApproved(s6.id, audit6.id, { client: tx });
      const r6b = await sendSellerAccountApproved(s6.id, audit6.id, { client: tx });
      ok("5h · first send with an override active succeeds", r6a.ok === true);
      ok("5h · duplicate call → deduped, not a 2nd send (idempotency unaffected by CMS overrides)", r6b.deduped === true || r6b.status === "DEDUPED");
      ok("5h · still exactly ONE EmailLog row for the key", (await tx.emailLog.count({ where: { idempotencyKey: `SELLER_ACCOUNT_APPROVED:${s6.id}:${audit6.id}` } })) === 1);

      // 5i — rejection reason remains authoritative even WITH a CMS override:
      // the CMS body omits {{reason}} entirely, but the real reason still lands
      // in the dispatched email (checked via EmailLog — text/html aren't stored
      // on the row, so assert indirectly: the send must SUCCEED, proving the
      // resolver did not throw/invent, and the pure-render test in section 3d
      // already proves the content contains the real reason verbatim).
      const s7 = await seedSeller(tx, "b7", "PENDING");
      const REAL_REASON = "Business registration could not be verified.";
      const audit7 = await seedAudit(tx, "seller.rejected", s7.id, { sellerId: s7.id, from: "PENDING", to: "REJECTED", reason: REAL_REASON });
      await seedTemplateOverride(tx, "seller_account_rejected", { subject: "Application update", heading: "An update", body: "Please review the details below.", extraMessage: "", actionLabel: "" });
      const r7 = await sendSellerAccountRejected(s7.id, audit7.id, { client: tx });
      ok("5i · rejection send with a reason-omitting CMS override still succeeds (reason enforced internally, not by the CMS text)", r7.ok === true, JSON.stringify(r7));

      // 5j — durable failure on an impossible missing-reason state: publish an
      // override for seller_account_rejected, then call the sender with an
      // audit row that has NO reason in its meta — the sender's OWN guard
      // already catches this before the templating layer is even reached
      // (failPrep("missing_reason_on_audit_row")), proving defense-in-depth:
      // the missing-reason case can NEVER reach a real send, override or not.
      const s8 = await seedSeller(tx, "b8", "PENDING");
      const audit8 = await seedAudit(tx, "seller.rejected", s8.id, { sellerId: s8.id, from: "PENDING", to: "REJECTED" }); // no reason
      await seedTemplateOverride(tx, "seller_account_rejected", { subject: "x", heading: "x", body: "x", extraMessage: "", actionLabel: "" });
      const r8 = await sendSellerAccountRejected(s8.id, audit8.id, { client: tx });
      ok("5j · missing-reason state → FAILED result, never sent, never invented", r8.ok === false);
      const failRow8 = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_REJECTED:${s8.id}:${audit8.id}` } });
      ok("5j · a durable FAILED EmailLog row records exactly why (failEmailPreparation)", failRow8?.status === "FAILED" && failRow8.error === "missing_reason_on_audit_row");

      // 5k — PayMongo email still works with the CMS mechanism wired in (no
      // override present → identical to pre-9F-57 behavior).
      const buyerEmail = `buyer-9f57@t.test`;
      const buyer = await tx.user.create({ data: { email: buyerEmail, name: "Buyer" }, select: { id: true } });
      const order = await tx.order.create({
        data: { orderNumber: `AX-T9F57-${Date.now().toString(36)}`, userId: buyer.id, email: buyerEmail, status: "PAID", paymentMethod: "CARD", paymentStatus: "PAID", subtotal: 100000, grandTotal: 100000, shippingAddress: "{}" },
        select: { id: true, orderNumber: true },
      });
      await tx.payment.create({ data: { orderId: order.id, provider: "paymongo", providerObject: "checkout_session", providerId: `cs_9f57_${Date.now()}`, status: "PAID", method: "card", amount: 100000, currency: "PHP", checkoutUrl: "https://checkout.paymongo.test/x", metadata: "{}", paidAt: new Date() } });
      const rPay = await sendPaymentConfirmation(order.id, { client: tx });
      ok("5k · sendPaymentConfirmation (no override) still routes exactly as before", rPay.ok === true, JSON.stringify(rPay));

      // 5l — CMS override ALSO works for a PayMongo (customer) template.
      const order2 = await tx.order.create({
        data: { orderNumber: `AX-T9F57B-${Date.now().toString(36)}`, userId: buyer.id, email: buyerEmail, status: "PENDING_PAYMENT", paymentMethod: "NONE", paymentStatus: "PENDING", subtotal: 50000, grandTotal: 50000, shippingAddress: "{}" },
        select: { id: true },
      });
      const payment2 = await tx.payment.create({ data: { orderId: order2.id, provider: "paymongo", providerObject: "checkout_session", providerId: `cs_9f57b_${Date.now()}`, status: "FAILED", amount: 50000, currency: "PHP", checkoutUrl: "https://checkout.paymongo.test/y", metadata: "{}" }, select: { id: true } });
      await seedTemplateOverride(tx, "payment_failed", { subject: "We couldn't charge you for {{orderNumber}}", heading: "", body: "", extraMessage: "", actionLabel: "" });
      const rPayFail = await sendPaymentFailed(payment2.id, { client: tx });
      ok("5l · CMS-overridden payment_failed send succeeds", rPayFail.ok === true, JSON.stringify(rPayFail));

      // 5m — the "submitted" application ack (a different recipient-resolution
      // path — supportEmail directly, no seller-portal team yet) is ALSO
      // CMS-overridable.
      const s9 = await seedSeller(tx, "b9", "PENDING");
      await seedTemplateOverride(tx, "seller_account_submitted", { subject: "Thanks for applying, {{sellerName}}", heading: "", body: "", extraMessage: "", actionLabel: "" });
      const rSubmitted = await sendSellerAccountSubmitted(s9.id, { client: tx });
      ok("5m · CMS-overridden seller_account_submitted send succeeds", rSubmitted.ok === true, JSON.stringify(rSubmitted));
      const logSubmitted = await tx.emailLog.findUnique({ where: { idempotencyKey: `SELLER_ACCOUNT_SUBMITTED:${s9.id}` }, select: { subject: true } });
      ok("5m · EmailLog subject reflects the custom override with sellerName substituted", logSubmitted?.subject === `Thanks for applying, Seller b9`);

      throw new Rollback();
    }, { timeout: 60_000, maxWait: 15_000 });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
}

async function isolationCheck() {
  console.log("\n── 6 · isolation ──");
  const [sellers, blocks, emails, audits] = await Promise.all([
    prisma.seller.count({ where: { slug: { startsWith: "s9f57-" } } }),
    prisma.contentBlock.count({ where: { area: "email" } }),
    prisma.emailLog.count({ where: { idempotencyKey: { contains: "T9F57" } } }),
    prisma.adminAuditLog.count({ where: { summary: "x", targetType: "seller" } }),
  ]);
  ok("6 · no fixture Seller leaked", sellers === 0);
  ok("6 · no email_template ContentBlock leaked (all seeded overrides rolled back)", blocks === 0);
  ok("6 · no fixture EmailLog leaked", emails === 0);
  ok("6 · no fixture AdminAuditLog leaked", audits === 0);
}

async function main() {
  console.log("\nPHASE 9F-57 — CMS email-template customization layer\n");
  registryTests();
  tokenSubstitutionTests();
  renderOverrideTests();
  staticWiringTests();
  await dbTests();
  await isolationCheck();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
