import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * "Your refund is complete" (Step 21 P3). Fired on
 * REFUND_INITIATED → REFUND_COMPLETED. Still bookkeeping — the store has marked
 * the refund done on their side. Never names a payment method the customer did
 * not use.
 */

export type ReturnRefundCompletedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  refundAmount: number; // centavos
  refundMethod: string | null;
  refundReference: string | null;
};

export function renderReturnRefundCompleted(d: ReturnRefundCompletedData) {
  const subject = `Your refund is complete`;
  const reason = reasonFor("return", d.brand);

  const rows =
    kvRow("Refund amount", peso(d.refundAmount)) +
    (d.refundMethod ? kvRow("Refund method", d.refundMethod) : "") +
    (d.refundReference ? kvRow("Reference", d.refundReference) : "") +
    kvRow("Return reference", d.returnNumber, { last: true });

  const body = `
    ${heading("Your refund is complete")}
    ${paragraph(`Hi ${d.customerName}, your refund of ${peso(d.refundAmount)} for return ${d.returnNumber} (order ${d.orderNumber}) has been completed on our side.`)}
    ${infoBox(rows)}
    ${paragraph("Depending on your bank it may still take a few business days to appear. If you don't see it after that, reply to our support team with your return reference.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Refund of ${peso(d.refundAmount)} for return ${d.returnNumber} is complete.`,
    reason,
  });

  const text = textBody([
    `Your refund is complete`,
    ``,
    `Hi ${d.customerName}, your refund of ${peso(d.refundAmount)} for return ${d.returnNumber}`,
    `(order ${d.orderNumber}) has been completed on our side.`,
    ``,
    `Refund amount:     ${peso(d.refundAmount)}`,
    ...(d.refundMethod ? [`Refund method:     ${d.refundMethod}`] : []),
    ...(d.refundReference ? [`Reference:         ${d.refundReference}`] : []),
    `Return reference:  ${d.returnNumber}`,
    ``,
    `Depending on your bank it may still take a few business days to appear. If you don't see`,
    `it after that, reply to our support team with your return reference.`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
