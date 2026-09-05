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
