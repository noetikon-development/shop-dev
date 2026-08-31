import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Refund completed (Step 21 P4). DORMANT — fired by a signature-verified
 * PayMongo `refund.updated = succeeded` webhook. Online payment is disabled, so
 * this never sends. When it does, `methodLabel` is a real, known method.
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
  const subject = `Your refund is complete`;
  const reason = reasonFor("return", d.brand);

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
    previewText: `Refund of ${peso(d.amount)} for return ${d.returnNumber} is complete.`,
    reason,
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
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
