import { layout, heading, paragraph, button, infoBox, kvRow, peso, textBody } from "@/lib/email/html";

/**
 * Cancellation notification (Step 17 §10). States the order was cancelled and
 * the order total. It does NOT claim a refund was issued — PayMongo and refunds
 * are deferred; there is no payment or refund to report.
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
  const subject = `Order ${d.orderNumber} cancelled — ${d.brand}`;

  const rows =
    kvRow("Order number", d.orderNumber) +
    kvRow("Status", "Cancelled") +
    kvRow("Order total", peso(d.grandTotal), { last: !d.reason }) +
    (d.reason ? kvRow("Reason", d.reason, { last: true }) : "");

  const body = `
    ${heading("Your order has been cancelled")}
    ${paragraph(`Hi ${d.customerName}, your order has been cancelled.`)}
    ${infoBox(rows)}
    ${paragraph("This order was not charged. If you were expecting to pay on delivery, there is nothing owed.")}
    ${button("View your order", d.orderUrl)}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `Order ${d.orderNumber} cancelled` });

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
    `This order was not charged.`,
    ``,
    `View your order: ${d.orderUrl}`,
  ]);

  return { subject, html, text };
}
