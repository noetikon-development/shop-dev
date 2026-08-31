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
  textFooter,
  reasonFor,
} from "@/lib/email/html";

/**
 * Order confirmation (Step 17 §6; Batch 3 Phase 2). Built ONLY from the
 * authoritative order snapshot — items/prices/discount/shipping come from the
 * OrderItem rows and the order's immutable coupon/shipping snapshots, never from
 * the browser or the current Product/Coupon/ShippingMethod records.
 *
 * The store's policy is pay on delivery — this email confirms the order was
 * received and never claims a payment has occurred.
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
  /** true while the order is PENDING_PAYMENT (the normal pay-on-delivery state). */
  payOnDelivery: boolean;
};

export function renderOrderConfirmation(d: OrderConfirmationData) {
  const subject = `Your ${d.brand} order is confirmed`;
  const reason = reasonFor("order", d.brand);
  const dateStr = d.placedAt.toISOString().slice(0, 10);

  const paymentLine = d.payOnDelivery
    ? "Your order has been received. Payment is arranged on delivery."
    : "Your order has been received.";

  const totalsRows =
    kvRow("Subtotal", peso(d.subtotal)) +
    (d.discountTotal > 0
      ? kvRow(`Discount${d.couponCode ? ` (${d.couponCode})` : ""}`, `-${peso(d.discountTotal)}`)
      : "") +
    kvRow(d.shippingMethodName ? `Shipping · ${d.shippingMethodName}` : "Shipping", d.shippingFee === 0 ? "Free" : peso(d.shippingFee)) +
    kvRow("Total", peso(d.grandTotal), { strong: true, last: true });

  const body = `
    ${heading("Your order is confirmed")}
    ${paragraph(`Hi ${d.customerName}, thanks for your order — it's confirmed and we're getting it ready. ${paymentLine}`)}
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
    previewText: `Order ${d.orderNumber} · placed ${dateStr}${d.payOnDelivery ? " · pay on delivery" : ""}.`,
    reason,
  });

  const addr = d.shippingAddress;
  const text = textBody([
    `Your order is confirmed`,
    ``,
    `Hi ${d.customerName}, thanks for your order — it's confirmed and we're getting it ready.`,
    paymentLine,
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
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
