import { layout, heading, paragraph, button, infoBox, kvRow, addressBlock, textBody } from "@/lib/email/html";

/**
 * Shipment notification (Step 17 §7). Uses the Step 13 fulfilment data on the
 * order — courier, tracking number, tracking URL, shippedAt. Nothing is invented.
 */

export type OrderShippedData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  courierLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: Date | null;
  shippingAddress: Record<string, unknown>;
};

export function renderOrderShipped(d: OrderShippedData) {
  const subject = `Order ${d.orderNumber} is on its way — ${d.brand}`;
  const shippedStr = d.shippedAt ? d.shippedAt.toISOString().slice(0, 10) : null;

  const rows =
    kvRow("Order number", d.orderNumber) +
    kvRow("Courier", d.courierLabel) +
    (d.trackingNumber ? kvRow("Tracking number", d.trackingNumber) : "") +
    (shippedStr ? kvRow("Shipped", shippedStr, { last: !d.trackingNumber }) : "");

  const body = `
    ${heading("Your order has shipped")}
    ${paragraph(`Hi ${d.customerName}, your order is on its way.`)}
    ${infoBox(rows)}
    ${d.trackingUrl ? button("Track your parcel", d.trackingUrl) : button("View your order", d.orderUrl)}
    <h2 style="margin:22px 0 10px;font-size:15px;color:#2b2926;">Shipping to</h2>
    ${addressBlock(d.shippingAddress)}
    ${paragraph("You can also follow the delivery from your order page.")}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `Order ${d.orderNumber} shipped` });

  const text = textBody([
    `Your order has shipped`,
    ``,
    `Hi ${d.customerName}, your order is on its way.`,
    ``,
    `Order number:    ${d.orderNumber}`,
    `Courier:         ${d.courierLabel}`,
    ...(d.trackingNumber ? [`Tracking number: ${d.trackingNumber}`] : []),
    ...(shippedStr ? [`Shipped:         ${shippedStr}`] : []),
    ...(d.trackingUrl ? [``, `Track your parcel: ${d.trackingUrl}`] : []),
    ``,
    `View your order: ${d.orderUrl}`,
  ]);

  return { subject, html, text };
}
