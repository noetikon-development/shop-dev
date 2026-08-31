import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody } from "@/lib/email/html";

/**
 * "Your refund is being processed" (Step 21 P3). Fired on
 * RECEIVED → REFUND_INITIATED. This is BOOKKEEPING — the store records the
 * refund and processes it through their own provider / bank; the wording never
 * implies an automatic card refund.
 */

export type ReturnRefundInitiatedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  refundAmount: number; // centavos
  refundMethod: string; // e.g. "Original payment method", "Store credit"
};

export function renderReturnRefundInitiated(d: ReturnRefundInitiatedData) {
  const subject = `Your refund for return ${d.returnNumber} is being processed — ${d.brand}`;

  const body = `
    ${heading("Your refund is being processed")}
    ${paragraph(`Hi ${d.customerName}, we've started your refund for return ${d.returnNumber} (order ${d.orderNumber}).`)}
    ${infoBox(
      kvRow("Refund amount", peso(d.refundAmount)) +
        kvRow("Refunded to", d.refundMethod) +
        kvRow("Return reference", d.returnNumber, { last: true }),
    )}
    ${paragraph("Depending on the original payment method it can take a few business days for the refund to reach you. We'll email you again once it's completed.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Your refund for return ${d.returnNumber} is being processed`,
  });

  const text = textBody([
    `Your refund is being processed`,
    ``,
    `Hi ${d.customerName}, we've started your refund for return ${d.returnNumber} (order ${d.orderNumber}).`,
    ``,
    `Refund amount:     ${peso(d.refundAmount)}`,
    `Refunded to:       ${d.refundMethod}`,
    `Return reference:  ${d.returnNumber}`,
    ``,
    `Depending on the original payment method it can take a few business days for the`,
    `refund to reach you. We'll email you again once it's completed.`,
    ``,
    `View your return: ${d.returnUrl}`,
  ]);

  return { subject, html, text };
}
