import { layout, heading, paragraph, button, infoBox, kvRow, textBody } from "@/lib/email/html";

/**
 * "Out for delivery" notification (Step 21 P1). Fired when an admin moves a
 * SHIPPED order to OUT_FOR_DELIVERY. Reuses the Step 13 fulfilment data already
 * on the order (courier, tracking number, tracking URL) — nothing is invented,
 * and each field is only shown when present. Store-pickup orders never reach
 * this status, so there is always a courier.
 */

export type OutForDeliveryData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  courierLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
};

export function renderOutForDelivery(d: OutForDeliveryData) {
  const subject = `Order ${d.orderNumber} is out for delivery — ${d.brand}`;

  const rows =
    kvRow("Order number", d.orderNumber) +
    kvRow("Courier", d.courierLabel, { last: !d.trackingNumber }) +
    (d.trackingNumber ? kvRow("Tracking number", d.trackingNumber, { last: true }) : "");

  const body = `
    ${heading("Your order is out for delivery")}
    ${paragraph(`Hi ${d.customerName}, your order is with the courier and should arrive today. Someone may need to be available to receive it.`)}
    ${infoBox(rows)}
    ${d.trackingUrl ? button("Track your parcel", d.trackingUrl) : button("View your order", d.orderUrl)}
    ${paragraph("You can also follow the delivery from your order page.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Order ${d.orderNumber} is out for delivery`,
  });

  const text = textBody([
    `Your order is out for delivery`,
    ``,
    `Hi ${d.customerName}, your order is with the courier and should arrive today.`,
    ``,
    `Order number:    ${d.orderNumber}`,
    `Courier:         ${d.courierLabel}`,
    ...(d.trackingNumber ? [`Tracking number: ${d.trackingNumber}`] : []),
    ...(d.trackingUrl ? [``, `Track your parcel: ${d.trackingUrl}`] : []),
    ``,
    `View your order: ${d.orderUrl}`,
  ]);

  return { subject, html, text };
}
