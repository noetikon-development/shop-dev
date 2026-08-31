import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * "Your refund is being processed" (Step 21 P3). Fired on
 * RECEIVED → REFUND_INITIATED. This is BOOKKEEPING — the store records the
 * refund and arranges it through their own bank / provider. The wording never
 * implies an automatic card refund and never names a payment method the
 * customer did not use (a pay-on-delivery order has no card on file).
 */

export type ReturnRefundInitiatedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  refundAmount: number; // centavos
  /** The method an admin recorded (e.g. "GCash", "Bank transfer"), or null. */
  refundMethod: string | null;
};

export function renderReturnRefundInitiated(d: ReturnRefundInitiatedData) {
  const subject = `Your refund is being processed`;
  const reason = reasonFor("return", d.brand);

  const rows =
    kvRow("Refund amount", peso(d.refundAmount)) +
    (d.refundMethod ? kvRow("Refund method", d.refundMethod) : "") +
    kvRow("Return reference", d.returnNumber, { last: true });

  const methodLine = d.refundMethod
    ? `We're sending it via ${d.refundMethod}.`
    : `Our team will confirm how the refund will reach you.`;

  const body = `
    ${heading("Your refund is being processed")}
    ${paragraph(`Hi ${d.customerName}, we've started your refund of ${peso(d.refundAmount)} for return ${d.returnNumber} (order ${d.orderNumber}). ${methodLine}`)}
    ${infoBox(rows)}
    ${paragraph("It can take a few business days for the refund to reach you. We'll email you again once it's complete.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Refund of ${peso(d.refundAmount)} for return ${d.returnNumber} is on its way.`,
    reason,
  });

  const text = textBody([
    `Your refund is being processed`,
    ``,
    `Hi ${d.customerName}, we've started your refund of ${peso(d.refundAmount)} for return ${d.returnNumber}`,
    `(order ${d.orderNumber}). ${methodLine}`,
    ``,
    `Refund amount:     ${peso(d.refundAmount)}`,
    ...(d.refundMethod ? [`Refund method:     ${d.refundMethod}`] : []),
    `Return reference:  ${d.returnNumber}`,
    ``,
    `It can take a few business days for the refund to reach you. We'll email you again once it's complete.`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
