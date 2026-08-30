import {
  layout,
  heading,
  paragraph,
  button,
  infoBox,
  kvRow,
  itemsTable,
  addressBlock,
  peso,
  textBody,
} from "@/lib/email/html";

/**
 * Order confirmation (Step 17 §6). Built ONLY from the authoritative order
 * snapshot — items/prices/discount/shipping come from the OrderItem rows and the
 * order's immutable coupon/shipping snapshots, never from the browser or the
 * current Product/Coupon/ShippingMethod records.
 *
 * PayMongo is deferred: orders are PENDING_PAYMENT. This email says
 * "Your order has been received" and never claims payment succeeded.
 */

export type OrderConfirmationData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  placedAt: Date;
  customerName: string;
  items: { name: string; variantLabel: string | null; quantity: number; unitPrice: number; lineTotal: number }[];
  subtotal: number;
  discountTotal: number;
  couponCode: string | null;
  shippingMethodName: string | null;
  shippingFee: number;
  grandTotal: number;
  shippingAddress: Record<string, unknown>;
  paymentStateNote: string;
};

export function renderOrderConfirmation(d: OrderConfirmationData) {
  const subject = `Order ${d.orderNumber} received — ${d.brand}`;

  const dateStr = d.placedAt.toISOString().slice(0, 10);
  const totalsRows =
    kvRow("Subtotal", peso(d.subtotal)) +
    (d.discountTotal > 0
      ? kvRow(`Discount${d.couponCode ? ` (${d.couponCode})` : ""}`, `-${peso(d.discountTotal)}`)
      : "") +
    kvRow(d.shippingMethodName ? `Shipping · ${d.shippingMethodName}` : "Shipping", d.shippingFee === 0 ? "Free" : peso(d.shippingFee)) +
    kvRow("Total", peso(d.grandTotal), { strong: true, last: true });

  const body = `
    ${heading("Thanks — your order has been received")}
    ${paragraph(`Hi ${d.customerName}, we've received your order. ${d.paymentStateNote}`)}
    ${button("View your order", d.orderUrl)}
    ${infoBox(kvRow("Order number", d.orderNumber) + kvRow("Order date", dateStr, { last: true }))}
    <h2 style="margin:22px 0 10px;font-size:15px;color:#2b2926;">Items</h2>
    ${itemsTable(d.items)}
    ${infoBox(totalsRows)}
    <h2 style="margin:22px 0 10px;font-size:15px;color:#2b2926;">Shipping to</h2>
    ${addressBlock(d.shippingAddress)}
    ${paragraph("You can follow your order's progress any time from the link above.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Order ${d.orderNumber} received`,
  });

  const addr = d.shippingAddress;
  const text = textBody([
    `Thanks — your order has been received`,
    ``,
    `Hi ${d.customerName}, we've received your order. ${d.paymentStateNote}`,
    ``,
    `Order number: ${d.orderNumber}`,
    `Order date:   ${dateStr}`,
    ``,
    `Items:`,
    ...d.items.map(
      (it) =>
        `  - ${it.name}${it.variantLabel ? ` (${it.variantLabel})` : ""} x${it.quantity}  ${peso(it.lineTotal)}`,
    ),
    ``,
    `Subtotal:  ${peso(d.subtotal)}`,
    ...(d.discountTotal > 0 ? [`Discount:  -${peso(d.discountTotal)}${d.couponCode ? ` (${d.couponCode})` : ""}`] : []),
    `Shipping:  ${d.shippingFee === 0 ? "Free" : peso(d.shippingFee)}${d.shippingMethodName ? ` (${d.shippingMethodName})` : ""}`,
    `Total:     ${peso(d.grandTotal)}`,
    ``,
    `Shipping to:`,
    `  ${[addr.firstName, addr.lastName].filter(Boolean).join(" ") || String(addr.recipient ?? "")}`,
    `  ${[addr.line1, addr.line2].filter(Boolean).join(", ")}`,
    `  ${[addr.barangay, addr.city, addr.province, addr.postalCode].filter(Boolean).join(", ")}`,
    ``,
    `View your order: ${d.orderUrl}`,
  ]);

  return { subject, html, text };
}
