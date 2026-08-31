import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Refund issued (Step 21 P4). DORMANT — fired only when a provider-side refund
 * has been requested for a return that settled a real PayMongo payment. Online
 * payment is disabled, so this never sends. When it does, `methodLabel` is a
 * real, known method ("your card", "your GCash account").
 */

export type RefundIssuedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  orderNumber: string;
  returnNumber: string;
  customerName: string;
  amount: number; // centavos
  methodLabel: string; // "your card" | "your GCash account" | "your original payment method"
};

export function renderRefundIssued(d: RefundIssuedData) {
  const subject = `Your refund has been issued`;
  const reason = reasonFor("return", d.brand);

  const body = `
    ${heading("Your refund has been issued")}
    ${paragraph(`Hi ${d.customerName}, we've issued a refund of ${peso(d.amount)} to ${d.methodLabel} for return ${d.returnNumber} (order ${d.orderNumber}).`)}
    ${infoBox(
      kvRow("Refund amount", peso(d.amount)) +
        kvRow("Refunded to", d.methodLabel) +
        kvRow("Return reference", d.returnNumber) +
        kvRow("Order", d.orderNumber, { last: true }),
    )}
    ${paragraph("It can take a few business days for the refund to appear on your statement, depending on your bank or wallet provider. We'll email you again once it's confirmed as complete.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Refund of ${peso(d.amount)} for return ${d.returnNumber} has been issued.`,
    reason,
  });

  const text = textBody([
    `Your refund has been issued`,
    ``,
    `Hi ${d.customerName}, we've issued a refund of ${peso(d.amount)} to ${d.methodLabel}`,
    `for return ${d.returnNumber} (order ${d.orderNumber}).`,
    ``,
    `Refund amount:     ${peso(d.amount)}`,
    `Refunded to:       ${d.methodLabel}`,
    `Return reference:  ${d.returnNumber}`,
    `Order:             ${d.orderNumber}`,
    ``,
    `It can take a few business days for the refund to appear. We'll email again once complete.`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
