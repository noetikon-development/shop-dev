import { layout, heading, paragraph, button, infoBox, kvRow, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Delivery confirmation (Step 17 §9). Concise — order number, name, delivery
 * date, link. No internal admin information.
 */

export type OrderDeliveredData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  deliveredAt: Date | null;
  storePickup: boolean;
};

export function renderOrderDelivered(d: OrderDeliveredData) {
  const verb = d.storePickup ? "collected" : "delivered";
  const subject = `Your ${d.brand} order has been ${verb}`;
  const reason = reasonFor("order", d.brand);
  const dateStr = d.deliveredAt ? d.deliveredAt.toISOString().slice(0, 10) : null;

  const body = `
    ${heading(d.storePickup ? "Your order has been collected" : "Your order has been delivered")}
    ${paragraph(`Hi ${d.customerName}, your order has been ${verb}. We hope everything's just right.`)}
    ${infoBox(
      kvRow("Order number", d.orderNumber) + (dateStr ? kvRow(d.storePickup ? "Collected" : "Delivered", dateStr, { last: true }) : ""),
    )}
    ${button("View your order", d.orderUrl)}
    ${paragraph("Changed your mind about something? You have 30 days to start a return from your order page.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Order ${d.orderNumber} — ${verb}${dateStr ? ` ${dateStr}` : ""}. 30-day returns if anything's off.`,
    reason,
  });

  const text = textBody([
    d.storePickup ? `Your order has been collected` : `Your order has been delivered`,
    ``,
    `Hi ${d.customerName}, your order has been ${verb}.`,
    ``,
    `Order number: ${d.orderNumber}`,
    ...(dateStr ? [`${d.storePickup ? "Collected" : "Delivered"}: ${dateStr}`] : []),
    ``,
    `View your order: ${d.orderUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
