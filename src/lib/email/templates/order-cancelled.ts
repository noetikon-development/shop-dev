import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Cancellation notification (Step 17 §10). States the order was cancelled and
 * the order total. It does NOT claim a refund was issued — the store's policy is
 * pay on delivery, so a cancelled order was never charged.
 */

export type OrderCancelledData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  grandTotal: number;
  reason: string | null;
};

export function renderOrderCancelled(d: OrderCancelledData) {
  const subject = `Your ${d.brand} order was cancelled`;
  const reasonLine = reasonFor("order", d.brand);

  const rows =
    kvRow("Order number", d.orderNumber) +
    kvRow("Status", "Cancelled") +
    kvRow("Order total", peso(d.grandTotal), { last: !d.reason }) +
    (d.reason ? kvRow("Reason", d.reason, { last: true }) : "");

  const body = `
    ${heading("Your order has been cancelled")}
    ${paragraph(`Hi ${d.customerName}, your order has been cancelled.`)}
    ${infoBox(rows)}
    ${paragraph("This order was not charged. As payment is arranged on delivery, there is nothing owed.")}
    ${button("View your order", d.orderUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Order ${d.orderNumber} — nothing was charged.`,
    reason: reasonLine,
  });

  const text = textBody([
    `Your order has been cancelled`,
    ``,
    `Hi ${d.customerName}, your order has been cancelled.`,
    ``,
    `Order number: ${d.orderNumber}`,
    `Status:       Cancelled`,
    `Order total:  ${peso(d.grandTotal)}`,
    ...(d.reason ? [`Reason:       ${d.reason}`] : []),
    ``,
    `This order was not charged. As payment is arranged on delivery, there is nothing owed.`,
    ``,
    `View your order: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reasonLine),
  ]);

  return { subject, html, text };
}
