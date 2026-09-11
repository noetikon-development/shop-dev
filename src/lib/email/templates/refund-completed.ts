import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Refund completed (Step 21 P4; 9F-55 added `refundedAt` / `statusLabel`).
 * Fired ONLY by a signature-verified PayMongo `refund.updated = succeeded`
 * webhook. `methodLabel` is a plain "Card" / "GCash" (never invented).
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
  // 9F-55: the two fields the PayMongo-webhook refund confirmation was missing
  // — WHEN the provider settled it, and an explicit status word (not just
  // implied by the heading).
  refundedAt: Date;
  statusLabel: string;
};

export function renderRefundCompleted(d: RefundCompletedData) {
  const subject = `Your refund is complete`;
  const reason = reasonFor("return", d.brand);
  const when = d.refundedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const body = `
    ${heading("Your refund is complete")}
    ${paragraph(`Hi ${d.customerName}, your ${d.partial ? "partial " : ""}refund of ${peso(d.amount)} for return ${d.returnNumber} (order ${d.orderNumber}) has been completed via ${d.methodLabel}.`)}
    ${infoBox(
      kvRow("Refund amount", peso(d.amount)) +
        kvRow("Payment method", d.methodLabel) +
        kvRow("Refund status", d.statusLabel) +
        kvRow("Refunded on", when) +
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
    `${d.returnNumber} (order ${d.orderNumber}) has been completed via ${d.methodLabel}.`,
    ``,
    `Refund amount:     ${peso(d.amount)}`,
    `Payment method:    ${d.methodLabel}`,
    `Refund status:     ${d.statusLabel}`,
    `Refunded on:       ${when}`,
    `Return reference:  ${d.returnNumber}`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
