import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter } from "@/lib/email/html";

/**
 * Axiaro Operations notifications (Phase 9F-7b).
 *
 * All three go to the ops inbox (`getSupportInboxEmail()`), never a seller or
 * customer address — companions to an existing customer-facing notice, not a
 * replacement for it. Same "internal notice" shape as `return_inbound`
 * (Step 21 P3): from orders@axiaro.shop, no staff note / token / secret.
 */

const opsReason = "You're receiving this because you're on the Axiaro operations team.";

export function renderOrderReceivedOps(d: {
  brand: string;
  siteUrl: string;
  orderNumber: string;
  orderUrl: string;
  customerEmail: string;
  itemCount: number;
  grandTotal: number;
  placedAt: Date;
}) {
  const dateStr = d.placedAt.toISOString().slice(0, 10);
  const subject = `New order ${d.orderNumber} — ${peso(d.grandTotal)}`;
  const body = `
    ${heading("New order received")}
    ${paragraph(`Order ${d.orderNumber} was placed on ${d.brand}.`)}
    ${infoBox(
      kvRow("Order", d.orderNumber) +
        kvRow("Placed", dateStr) +
        kvRow("Customer", d.customerEmail) +
        kvRow("Items", String(d.itemCount)) +
        kvRow("Total", peso(d.grandTotal), { last: true }),
    )}
    ${button("View the order", d.orderUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "New order received",
      ``,
      `Order ${d.orderNumber} was placed on ${d.brand}.`,
      ``,
      `Order: ${d.orderNumber}`,
      `Placed: ${dateStr}`,
      `Customer: ${d.customerEmail}`,
      `Items: ${d.itemCount}`,
      `Total: ${peso(d.grandTotal)}`,
      ``,
      `View the order: ${d.orderUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * Ops notice — a THIRD_PARTY seller published a listing (offer → ACTIVE), so it
 * is now buy-box-eligible on the storefront (9F-24D P1-7). Companion to the
 * seller's own action; goes to the ops inbox only. Carries listing metadata
 * (seller, product, option, price, condition) — no customer data.
 */
export function renderSellerOfferPublishedOps(d: {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  sellerName: string;
  productName: string;
  optionLabel: string;
  sku: string;
  price: number;
  condition: string;
  publishedAt: Date;
}) {
  const when = `${d.publishedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const subject = `Listing published: ${d.sellerName} — ${d.productName} (${peso(d.price)})`;
  const rows =
    kvRow("Seller", d.sellerName) +
    kvRow("Product", d.productName) +
    kvRow("Option", d.optionLabel) +
    kvRow("SKU", d.sku) +
    kvRow("Condition", d.condition) +
    kvRow("Price", peso(d.price)) +
    kvRow("Published", when, { last: true });
  const body = `
    ${heading("A seller published a listing")}
    ${paragraph(`${d.sellerName} set a listing to Active on ${d.brand} — it is now visible to buyers on the storefront.`)}
    ${infoBox(rows)}
    ${paragraph("Review it against Axiaro's listing standards. To pull it, take the offer offline from the Offers area, or suspend the seller if it's serious.")}
    ${button("Open the offers list", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A seller published a listing",
      ``,
      `${d.sellerName} set a listing to Active on ${d.brand} — it is now visible to buyers on the storefront.`,
      ``,
      `Seller: ${d.sellerName}`,
      `Product: ${d.productName}`,
      `Option: ${d.optionLabel}`,
      `SKU: ${d.sku}`,
      `Condition: ${d.condition}`,
      `Price: ${peso(d.price)}`,
      `Published: ${when}`,
      ``,
      "Review it against Axiaro's listing standards. To pull it, take the offer offline from the Offers area, or suspend the seller if it's serious.",
      ``,
      `Open the offers list: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * Ops escalation — a THIRD_PARTY SellerOrder has sat PENDING_PAYMENT (the seller
 * has not accepted it) past the SLA escalation threshold (9F-32A). The customer's
 * order is confirmed and stuck. Ops should chase the seller or step in. Order /
 * seller metadata only — no customer name, address, phone or email.
 */
export function renderSellerOrderAcceptanceOverdueOps(d: {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  sellerName: string;
  orderNumber: string;
  sellerOrderStatus: string;
  waitedLabel: string;
  thresholdLabel: string;
  itemCount: number;
  placedAt: Date;
}) {
  const placed = `${d.placedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const subject = `Seller hasn't accepted order ${d.orderNumber} — ${d.sellerName} (${d.waitedLabel})`;
  const rows =
    kvRow("Seller", d.sellerName) +
    kvRow("Order", d.orderNumber) +
    kvRow("SellerOrder status", d.sellerOrderStatus) +
    kvRow("Waiting", d.waitedLabel) +
    kvRow("Escalation threshold", d.thresholdLabel) +
    kvRow("Items", String(d.itemCount)) +
    kvRow("Placed", placed, { last: true });
  const body = `
    ${heading("A seller hasn't accepted a confirmed order")}
    ${paragraph(`Order ${d.orderNumber} has been waiting ${d.waitedLabel} for ${d.sellerName} to accept it — past the ${d.thresholdLabel} escalation threshold. The customer's order is confirmed and will not progress until the seller accepts (or Axiaro cancels) it.`)}
    ${infoBox(rows)}
    ${paragraph("Chase the seller, or use the Admin order view to cancel it if they can't be reached. The customer has NOT been emailed about the delay.")}
    ${button("Open the order", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A seller hasn't accepted a confirmed order",
      ``,
      `Order ${d.orderNumber} has been waiting ${d.waitedLabel} for ${d.sellerName} to accept it — past the ${d.thresholdLabel} escalation threshold. The customer's order is confirmed and will not progress until the seller accepts (or Axiaro cancels) it.`,
      ``,
      `Seller: ${d.sellerName}`,
      `Order: ${d.orderNumber}`,
      `SellerOrder status: ${d.sellerOrderStatus}`,
      `Waiting: ${d.waitedLabel}`,
      `Escalation threshold: ${d.thresholdLabel}`,
      `Items: ${d.itemCount}`,
      `Placed: ${placed}`,
      ``,
      "Chase the seller, or use the Admin order view to cancel it if they can't be reached. The customer has NOT been emailed about the delay.",
      ``,
      `Open the order: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * Ops notice — a THIRD_PARTY seller declined / cancelled a customer's order they
 * can't fulfil (9F-30B). The customer's whole order was cancelled and their
 * stock restored; the customer has already been emailed. Ops needs to know so
 * they can follow up (source the item elsewhere, apologise, etc). Listing /
 * order metadata only — no customer name, address, phone or email.
 */
export function renderSellerOrderCancelledOps(d: {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  sellerName: string;
  orderNumber: string;
  action: "declined" | "cancelled";
  wasParentStatus: string;
  itemCount: number;
  restockedUnits: number;
  reason: string;
  cancelledAt: Date;
}) {
  const when = `${d.cancelledAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const subject = `Seller ${d.action} order ${d.orderNumber} — ${d.sellerName}`;
  const rows =
    kvRow("Seller", d.sellerName) +
    kvRow("Order", d.orderNumber) +
    kvRow("Action", d.action === "declined" ? "Declined (before starting)" : "Cancelled (in progress)") +
    kvRow("Was", d.wasParentStatus) +
    kvRow("Items", String(d.itemCount)) +
    kvRow("Units returned to stock", String(d.restockedUnits)) +
    kvRow("Reason", d.reason) +
    kvRow("When", when, { last: true });
  const body = `
    ${heading("A seller cancelled a customer's order")}
    ${paragraph(`${d.sellerName} ${d.action} order ${d.orderNumber} on ${d.brand} — the customer's whole order has been cancelled and the stock restored. The customer has been notified.`)}
    ${infoBox(rows)}
    ${paragraph("Follow up if the customer needs the item sourced another way.")}
    ${button("Open the order", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A seller cancelled a customer's order",
      ``,
      `${d.sellerName} ${d.action} order ${d.orderNumber} on ${d.brand} — the customer's whole order has been cancelled and the stock restored. The customer has been notified.`,
      ``,
      `Seller: ${d.sellerName}`,
      `Order: ${d.orderNumber}`,
      `Action: ${d.action === "declined" ? "Declined (before starting)" : "Cancelled (in progress)"}`,
      `Was: ${d.wasParentStatus}`,
      `Items: ${d.itemCount}`,
      `Units returned to stock: ${d.restockedUnits}`,
      `Reason: ${d.reason}`,
      `When: ${when}`,
      ``,
      "Follow up if the customer needs the item sourced another way.",
      ``,
      `Open the order: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * Ops alert — another transactional email FAILED or was SKIPPED for a delivery
 * reason (9F-18). Carries only operational metadata already held on the failed
 * `EmailLog` row: no customer/seller name, address, phone, full email, payout
 * figures, order totals, tokens, or the failed message body.
 */
export function renderEmailFailureAlertOps(d: {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  emailType: string;
  failureStatus: string;
  errorReason: string;
  emailLogId: string;
  recipientMasked: string;
  subject: string;
  orderNumber: string | null;
  attempts: number;
  failedAt: Date;
}) {
  const subject = `⚠ Email delivery failed — ${d.emailType}`;
  const when = `${d.failedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const rows =
    kvRow("Email type", d.emailType) +
    kvRow("Result", d.failureStatus) +
    kvRow("Reason", d.errorReason) +
    kvRow("Recipient", d.recipientMasked) +
    kvRow("Message subject", d.subject) +
    (d.orderNumber ? kvRow("Order", d.orderNumber) : "") +
    kvRow("Attempts", String(d.attempts)) +
    kvRow("EmailLog ID", d.emailLogId) +
    kvRow("Recorded", when, { last: true });
  const body = `
    ${heading("A transactional email was not delivered")}
    ${paragraph(`Axiaro's email subsystem recorded a ${d.failureStatus} result for a ${d.emailType} message — the recipient did not receive it.`)}
    ${infoBox(rows)}
    ${paragraph("Open the email log, resolve the underlying cause, then use Retry on that row.")}
    ${button("Open the email log", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A transactional email was not delivered",
      ``,
      `Axiaro's email subsystem recorded a ${d.failureStatus} result for a ${d.emailType} message — the recipient did not receive it.`,
      ``,
      `Email type: ${d.emailType}`,
      `Result: ${d.failureStatus}`,
      `Reason: ${d.errorReason}`,
      `Recipient: ${d.recipientMasked}`,
      `Message subject: ${d.subject}`,
      ...(d.orderNumber ? [`Order: ${d.orderNumber}`] : []),
      `Attempts: ${d.attempts}`,
      `EmailLog ID: ${d.emailLogId}`,
      `Recorded: ${when}`,
      ``,
      "Open the email log, resolve the underlying cause, then use Retry on that row.",
      ``,
      `Open the email log: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

type RefundOpsBase = {
  brand: string;
  siteUrl: string;
  returnNumber: string;
  orderNumber: string;
  adminUrl: string;
  refundAmount: number;
  refundMethod: string | null;
};

export function renderReturnRefundInitiatedOps(d: RefundOpsBase) {
  const subject = `Refund initiated (bookkeeping): ${d.returnNumber} — ${peso(d.refundAmount)}`;
  const body = `
    ${heading("A refund was recorded")}
    ${paragraph(`An admin recorded a bookkeeping refund for return ${d.returnNumber} (order ${d.orderNumber}).`)}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Amount", peso(d.refundAmount)) +
        kvRow("Method", d.refundMethod ?? "—", { last: true }),
    )}
    ${paragraph("This is a bookkeeping record only — no gateway was charged. Confirm the money actually moved through the original channel (bank transfer, GCash, cash, etc.).")}
    ${button("View the return", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A refund was recorded",
      ``,
      `An admin recorded a bookkeeping refund for return ${d.returnNumber} (order ${d.orderNumber}).`,
      ``,
      `Return: ${d.returnNumber}`,
      `Order: ${d.orderNumber}`,
      `Amount: ${peso(d.refundAmount)}`,
      `Method: ${d.refundMethod ?? "—"}`,
      ``,
      "This is a bookkeeping record only — no gateway was charged. Confirm the money actually moved through the original channel (bank transfer, GCash, cash, etc.).",
      ``,
      `View the return: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

export function renderReturnRefundCompletedOps(d: RefundOpsBase & { refundReference: string | null }) {
  const subject = `Refund completed (bookkeeping): ${d.returnNumber} — ${peso(d.refundAmount)}`;
  const body = `
    ${heading("A refund was marked complete")}
    ${paragraph(`An admin marked the bookkeeping refund for return ${d.returnNumber} (order ${d.orderNumber}) as complete.`)}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Amount", peso(d.refundAmount)) +
        kvRow("Method", d.refundMethod ?? "—") +
        kvRow("Reference", d.refundReference ?? "—", { last: true }),
    )}
    ${button("View the return", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A refund was marked complete",
      ``,
      `An admin marked the bookkeeping refund for return ${d.returnNumber} (order ${d.orderNumber}) as complete.`,
      ``,
      `Return: ${d.returnNumber}`,
      `Order: ${d.orderNumber}`,
      `Amount: ${peso(d.refundAmount)}`,
      `Method: ${d.refundMethod ?? "—"}`,
      `Reference: ${d.refundReference ?? "—"}`,
      ``,
      `View the return: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * 9F-62 — Ops notice: a new self-service seller application was submitted and
 * is waiting in the review queue. Companion to the applicant's own
 * `seller_account_submitted` acknowledgement (unchanged, still
 * `Seller.supportEmail` only) — that email tells the applicant Axiaro got
 * their application; this one tells Axiaro. `supportEmail` here is the
 * SELLER's own contact address (what they typed on the form), never the ops
 * inbox this message itself is delivered to. `applicantEmail` is the current
 * Axiaro account email behind the application (null only if somehow missing —
 * never expected for a self-service submission, since it always has one).
 */
export function renderSellerAccountSubmittedOps(d: {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  sellerName: string;
  status: string;
  supportEmail: string;
  applicantEmail: string | null;
}) {
  const subject = `New seller application: ${d.sellerName}`;
  const rows =
    kvRow("Seller", d.sellerName) +
    kvRow("Status", d.status) +
    kvRow("Support email", d.supportEmail) +
    kvRow("Applicant account", d.applicantEmail ?? "—", { last: true });
  const body = `
    ${heading("A new seller application was submitted")}
    ${paragraph(`${d.sellerName} applied to sell on ${d.brand} and is now under review.`)}
    ${infoBox(rows)}
    ${button("Review the application", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A new seller application was submitted",
      ``,
      `${d.sellerName} applied to sell on ${d.brand} and is now under review.`,
      ``,
      `Seller: ${d.sellerName}`,
      `Status: ${d.status}`,
      `Support email: ${d.supportEmail}`,
      `Applicant account: ${d.applicantEmail ?? "—"}`,
      ``,
      `Review the application: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * 9F-56 — a seller resubmitted a product request that already went through a
 * review cycle (REJECTED → reopened → DRAFT → PENDING again). Distinct from
 * the seller's own "submitted for review" ack, which fires for a first-time
 * submission too — this is the signal that tells Ops the review queue has a
 * request worth a second look, not a fresh one.
 */
export function renderSellerProductRequestResubmittedOps(d: {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  sellerName: string;
  productName: string;
}) {
  const subject = `Resubmitted for review: ${d.sellerName} — ${d.productName}`;
  const body = `
    ${heading("A product request was resubmitted")}
    ${paragraph(`${d.sellerName} resubmitted "${d.productName}" after an earlier review cycle. It's ready for another look.`)}
    ${infoBox(kvRow("Seller", d.sellerName) + kvRow("Product", d.productName, { last: true }))}
    ${button("Review the request", d.adminUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "A product request was resubmitted",
      ``,
      `${d.sellerName} resubmitted "${d.productName}" after an earlier review cycle. It's ready for another look.`,
      ``,
      `Seller: ${d.sellerName}`,
      `Product: ${d.productName}`,
      ``,
      `Review the request: ${d.adminUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * Ops alert — the scheduled reconciliation job (`reconciliation-job.ts`)
 * reported WARN or FAIL for its daily run. Never sent for a clean PASS.
 * `details` are the check modules' own non-PASS lines (already prefixed with
 * which check they came from), capped by the caller before this is called.
 */
export function renderReconciliationAlertOps(d: {
  brand: string;
  siteUrl: string;
  status: "WARN" | "FAIL";
  runAt: Date;
  payments: { pass: number; warn: number; fail: number };
  marketplace: { pass: number; warn: number; fail: number };
  details: string[];
  truncatedCount: number;
  auditUrl: string;
}) {
  const when = `${d.runAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const subject = `Reconciliation ${d.status} — ${when}`;
  const rows =
    kvRow("Status", d.status) +
    kvRow("Run at", when) +
    kvRow("Payments", `${d.payments.pass} pass · ${d.payments.warn} warn · ${d.payments.fail} fail`) +
    kvRow("Marketplace", `${d.marketplace.pass} pass · ${d.marketplace.warn} warn · ${d.marketplace.fail} fail`, { last: true });
  const detailParagraphs = d.details.map((line) => paragraph(line)).join("");
  const truncatedNote =
    d.truncatedCount > 0
      ? paragraph(`…and ${d.truncatedCount} more line(s) — see the full run record in the admin audit log.`)
      : "";
  const body = `
    ${heading("Reconciliation requires review")}
    ${paragraph(`Axiaro's scheduled reconciliation reported ${d.status} for its ${when} run.`)}
    ${infoBox(rows)}
    ${detailParagraphs}
    ${truncatedNote}
    ${button("Open the audit log", d.auditUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "Reconciliation requires review",
      ``,
      `Axiaro's scheduled reconciliation reported ${d.status} for its ${when} run.`,
      ``,
      `Status: ${d.status}`,
      `Run at: ${when}`,
      `Payments: ${d.payments.pass} pass · ${d.payments.warn} warn · ${d.payments.fail} fail`,
      `Marketplace: ${d.marketplace.pass} pass · ${d.marketplace.warn} warn · ${d.marketplace.fail} fail`,
      ``,
      ...d.details,
      ...(d.truncatedCount > 0 ? [`…and ${d.truncatedCount} more line(s) — see the full run record in the admin audit log.`] : []),
      ``,
      `Open the audit log: ${d.auditUrl}`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}

/**
 * Ops alert — the scheduled reconciliation job itself failed to complete (an
 * exception was thrown before either check finished), so no PASS/WARN/FAIL
 * result exists and no `AdminAuditLog` row was written for this run. Distinct
 * from `renderReconciliationAlertOps`, which reports a COMPLETED run that
 * found a WARN/FAIL business-data issue — this alert exists so an operator
 * also learns when reconciliation did not run at all, not only when it found
 * something wrong. `errorMessage` must already be sanitized by the caller
 * (no secrets, no stack trace) before reaching this template.
 */
export function renderReconciliationFailureAlertOps(d: {
  brand: string;
  siteUrl: string;
  failedAt: Date;
  route: string;
  errorMessage: string;
}) {
  const when = `${d.failedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  const subject = `Reconciliation job FAILED to run — ${when}`;
  const rows =
    kvRow("Failed at", when) +
    kvRow("Job", "Scheduled reconciliation") +
    kvRow("Route", d.route, { last: true });
  const body = `
    ${heading("Reconciliation did not complete")}
    ${paragraph(
      `Axiaro's scheduled reconciliation job failed to run to completion at ${when}. This is a job execution failure, not a detected reconciliation mismatch — the checks did not finish, so no result was produced for today's run.`,
    )}
    ${infoBox(rows)}
    ${paragraph(`Error: ${d.errorMessage}`)}
    ${paragraph("Investigate the job, the database connection, and the Vercel function logs for this route.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: opsReason }),
    text: textBody([
      "Reconciliation did not complete",
      ``,
      `Axiaro's scheduled reconciliation job failed to run to completion at ${when}.`,
      `This is a job execution failure, not a detected reconciliation mismatch — the checks did not finish, so no result was produced for today's run.`,
      ``,
      `Failed at: ${when}`,
      `Job: Scheduled reconciliation`,
      `Route: ${d.route}`,
      ``,
      `Error: ${d.errorMessage}`,
      ``,
      `Investigate the job, the database connection, and the Vercel function logs for this route.`,
      ...textFooter(d.brand, d.siteUrl, opsReason),
    ]),
  };
}
