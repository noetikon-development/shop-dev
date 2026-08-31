import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody } from "@/lib/email/html";

/**
 * Refund completed (Step 21 P4). Fired by a signature-verified PayMongo
 * `refund.updated = succeeded` webhook. Money has left the store's account.
 */

export type RefundCompletedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  orderNumber: string;
  returnNumber: string;
  customerName: string;
  amount: number; // centavos
  methodLabel: string;
  partial: boolean;
};

export function renderRefundCompleted(d: RefundCompletedData) {
  const subject = `Your refund for order ${d.orderNumber} is complete — ${d.brand}`;

  const body = `
    ${heading("Your refund is complete")}
    ${paragraph(`Hi ${d.customerName}, your ${d.partial ? "partial " : ""}refund of ${peso(d.amount)} for return ${d.returnNumber} (order ${d.orderNumber}) has been completed and sent to ${d.methodLabel}.`)}
    ${infoBox(
      kvRow("Refund amount", peso(d.amount)) +
        kvRow("Refunded to", d.methodLabel) +
        kvRow("Return reference", d.returnNumber, { last: true }),
    )}
    ${paragraph("Depending on your bank or wallet provider it may still take a few business days to appear. If you don't see it after that, reply to our support team with your return reference.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Your refund for order ${d.orderNumber} is complete`,
  });

  const text = textBody([
    `Your refund is complete`,
    ``,
    `Hi ${d.customerName}, your ${d.partial ? "partial " : ""}refund of ${peso(d.amount)} for return`,
    `${d.returnNumber} (order ${d.orderNumber}) has been completed and sent to ${d.methodLabel}.`,
    ``,
    `Refund amount:     ${peso(d.amount)}`,
    `Refunded to:       ${d.methodLabel}`,
    `Return reference:  ${d.returnNumber}`,
    ``,
    `View your return: ${d.returnUrl}`,
  ]);

  return { subject, html, text };
}
