import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Refund notification — TEMPLATE / SERVICE FOUNDATION ONLY (Step 17 §11).
 *
 * `sendRefundNotification(...)` is exported but not wired to any flow — the
 * P3/P4 return-refund emails cover the real cases. It exists so a future refund
 * event can call it with a genuine refund record. It must never be invoked
 * without a real refund source.
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
  const subject = `Your refund is being processed`;
  const reason = reasonFor("order", d.brand);

  const body = `
    ${heading("Your refund is being processed")}
    ${paragraph(`Hi ${d.customerName}, we've issued a refund of ${peso(d.refundAmount)} for order ${d.orderNumber}.`)}
    ${infoBox(
      kvRow("Order number", d.orderNumber) +
        kvRow("Refund amount", peso(d.refundAmount)) +
        kvRow("Refund method", d.method) +
        kvRow("Reference", d.refundReference, { last: true }),
    )}
    ${paragraph("It can take a few business days for the refund to reach you, depending on your bank or provider.")}
    ${button("View your order", d.orderUrl)}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `Refund for order ${d.orderNumber}.`, reason });

  const text = textBody([
    `Your refund is being processed`,
    ``,
    `Hi ${d.customerName}, we've issued a refund of ${peso(d.refundAmount)} for order ${d.orderNumber}.`,
    ``,
    `Order number:  ${d.orderNumber}`,
    `Refund amount: ${peso(d.refundAmount)}`,
    `Refund method: ${d.method}`,
    `Reference:     ${d.refundReference}`,
    ``,
    `View your order: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
