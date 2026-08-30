import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody } from "@/lib/email/html";

/**
 * Refund notification — TEMPLATE / SERVICE FOUNDATION ONLY (Step 17 §11).
 *
 * There is NO refund processing in this project and PayMongo is deferred. This
 * template exists so that when a real refund capability is added later, the
 * refund event can call `sendRefundNotification(...)` with a genuine refund
 * record. It must never be invoked without a real refund source.
 */

export type RefundNotificationData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  refundAmount: number;
  refundReference: string;
  method: string; // e.g. "original payment method"
};

export function renderRefundNotification(d: RefundNotificationData) {
  const subject = `Refund for order ${d.orderNumber} — ${d.brand}`;

  const body = `
    ${heading("Your refund is on its way")}
    ${paragraph(`Hi ${d.customerName}, we've issued a refund for order ${d.orderNumber}.`)}
    ${infoBox(
      kvRow("Order number", d.orderNumber) +
        kvRow("Refund amount", peso(d.refundAmount)) +
        kvRow("Refunded to", d.method) +
        kvRow("Reference", d.refundReference, { last: true }),
    )}
    ${paragraph("It can take a few business days for the refund to appear on your statement, depending on your bank or provider.")}
    ${button("View your order", d.orderUrl)}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `Refund for order ${d.orderNumber}` });

  const text = textBody([
    `Your refund is on its way`,
    ``,
    `Hi ${d.customerName}, we've issued a refund for order ${d.orderNumber}.`,
    ``,
    `Order number:  ${d.orderNumber}`,
    `Refund amount: ${peso(d.refundAmount)}`,
    `Refunded to:   ${d.method}`,
    `Reference:     ${d.refundReference}`,
    ``,
    `View your order: ${d.orderUrl}`,
  ]);

  return { subject, html, text };
}
