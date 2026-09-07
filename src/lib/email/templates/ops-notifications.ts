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
