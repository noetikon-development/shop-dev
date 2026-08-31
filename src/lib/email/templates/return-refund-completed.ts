import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody } from "@/lib/email/html";

/**
 * "Your refund is complete" (Step 21 P3). Fired on
 * REFUND_INITIATED → REFUND_COMPLETED. Still bookkeeping — the store has marked
 * the refund done on their side.
 */

export type ReturnRefundCompletedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  refundAmount: number; // centavos
  refundMethod: string;
  refundReference: string | null;
};

export function renderReturnRefundCompleted(d: ReturnRefundCompletedData) {
  const subject = `Your refund for return ${d.returnNumber} is complete — ${d.brand}`;

  const body = `
    ${heading("Your refund is complete")}
    ${paragraph(`Hi ${d.customerName}, your refund for return ${d.returnNumber} (order ${d.orderNumber}) has been completed on our side.`)}
    ${infoBox(
      kvRow("Refund amount", peso(d.refundAmount)) +
        kvRow("Refunded to", d.refundMethod) +
        (d.refundReference ? kvRow("Reference", d.refundReference) : "") +
        kvRow("Return reference", d.returnNumber, { last: true }),
    )}
    ${paragraph("If you don't see the refund after a few business days, reply to our support team with your return reference and we'll chase it up.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Your refund for return ${d.returnNumber} is complete`,
  });

  const text = textBody([
    `Your refund is complete`,
    ``,
    `Hi ${d.customerName}, your refund for return ${d.returnNumber} (order ${d.orderNumber})`,
    `has been completed on our side.`,
    ``,
    `Refund amount:     ${peso(d.refundAmount)}`,
    `Refunded to:       ${d.refundMethod}`,
    ...(d.refundReference ? [`Reference:         ${d.refundReference}`] : []),
    `Return reference:  ${d.returnNumber}`,
    ``,
    `If you don't see the refund after a few business days, reply to our support team`,
    `with your return reference and we'll chase it up.`,
    ``,
    `View your return: ${d.returnUrl}`,
  ]);

  return { subject, html, text };
}
