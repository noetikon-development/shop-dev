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
} from "@/lib/email/html";

/**
 * Seller order/return notifications (Phase 9F-7b; 9F-14 adds the new-order one).
 *
 * Recipients are the seller's ACTIVE OWNER / MANAGER members (+
 * `Seller.notifyEmail`) — same audience as the account/profile lifecycle
 * emails (9F-6b).
 */

type SellerOrderBase = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  orderNumber: string;
  ordersUrl: string;
};

/**
 * A brand-new SellerOrder for the seller to fulfil (9F-14). Carries only what
 * the seller needs to pick, pack and ship: the Axiaro order number, the item(s),
 * the money that determines their payout basis, the payment method (COD orders
 * are collected on delivery — the seller is NOT owed payment on receipt), and
 * the delivery address. NO customer email / account name / billing / order grand
 * total.
 */
export function renderSellerOrderReceived(
  d: SellerOrderBase & {
    orderUrl: string;
    items: { name: string; variantLabel: string | null; quantity: number; unitPrice: number; lineTotal: number }[];
    merchandiseSubtotal: number;
    discountAllocated: number;
    shippingFee: number;
    payoutBasis: number;
    paymentMethodLabel: string;
    shipTo: Record<string, unknown> | null;
  },
) {
  const subject = `New order ${d.orderNumber} — ${d.sellerName}`;
  const money =
    kvRow("Merchandise", peso(d.merchandiseSubtotal)) +
    (d.discountAllocated > 0 ? kvRow("Discount", `− ${peso(d.discountAllocated)}`) : "") +
    kvRow("Shipping", d.shippingFee === 0 ? "Free" : peso(d.shippingFee)) +
    kvRow("Your payout basis", peso(d.payoutBasis), { strong: true }) +
    kvRow("Payment", d.paymentMethodLabel, { last: true });
  const body = `
    ${heading("You have a new order")}
    ${paragraph(`Order ${d.orderNumber} is ready for ${d.sellerName} to fulfil. Accept it in the Seller Portal to start preparing.`)}
    ${itemsTable(d.items)}
    ${infoBox(money)}
    ${heading("Deliver to")}
    ${d.shipTo ? addressBlock(d.shipTo) : paragraph("No delivery address on file — check the Seller Portal.")}
    ${button("Open order in Seller Portal", d.orderUrl)}
  `;
  const reason = `You're receiving this because you manage a seller account on ${d.brand}.`;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason }),
    text: textBody([
      "You have a new order",
      ``,
      `Order ${d.orderNumber} is ready for ${d.sellerName} to fulfil.`,
      ``,
      ...d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""} — ${peso(i.lineTotal)}`),
      ``,
      `Merchandise: ${peso(d.merchandiseSubtotal)}`,
      ...(d.discountAllocated > 0 ? [`Discount: -${peso(d.discountAllocated)}`] : []),
      `Shipping: ${d.shippingFee === 0 ? "Free" : peso(d.shippingFee)}`,
      `Your payout basis: ${peso(d.payoutBasis)}`,
      `Payment: ${d.paymentMethodLabel}`,
      ``,
      "Deliver to:",
      ...(d.shipTo
        ? [d.shipTo.firstName, d.shipTo.lastName].filter(Boolean).join(" ")
          ? [
              [d.shipTo.firstName, d.shipTo.lastName].filter(Boolean).join(" "),
              String(d.shipTo.line1 ?? ""),
              String(d.shipTo.line2 ?? ""),
              [d.shipTo.barangay, d.shipTo.city].filter(Boolean).join(", "),
              [d.shipTo.province, d.shipTo.postalCode].filter(Boolean).join(" "),
              String(d.shipTo.country ?? ""),
              String(d.shipTo.phone ?? ""),
            ].filter((l) => l && l.trim())
          : ["(see the Seller Portal)"]
        : ["(see the Seller Portal)"]),
      ``,
      `Open the order: ${d.orderUrl}`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

export function renderSellerOrderCancelled(d: SellerOrderBase) {
  const subject = `Order ${d.orderNumber} was cancelled`;
  const body = `
    ${heading("An order was cancelled")}
    ${paragraph(`Order ${d.orderNumber}, which included items from ${d.sellerName}, was cancelled.`)}
    ${infoBox(kvRow("Order", d.orderNumber) + kvRow("Status", "Cancelled", { last: true }))}
    ${paragraph("No further action is needed on this order — any reserved stock has already been returned to your available inventory.")}
    ${button("View your orders", d.ordersUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: "You're receiving this because you manage a seller account on {brand}.".replace("{brand}", d.brand) }),
    text: textBody([
      "An order was cancelled",
      ``,
      `Order ${d.orderNumber}, which included items from ${d.sellerName}, was cancelled.`,
      ``,
      "No further action is needed on this order — any reserved stock has already been returned to your available inventory.",
      ``,
      `Your orders: ${d.ordersUrl}`,
      ...textFooter(d.brand, d.siteUrl, `You're receiving this because you manage a seller account on ${d.brand}.`),
    ]),
  };
}

export function renderSellerReturnReceived(
  d: SellerOrderBase & {
    returnNumber: string;
    returnsUrl: string;
    items: { name: string; variantLabel: string | null; quantity: number }[];
  },
) {
  const subject = `Return received: ${d.returnNumber} (order ${d.orderNumber})`;
  const itemLines = d.items.map((i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`);
  const body = `
    ${heading("A return was received")}
    ${paragraph(`Axiaro received the returned item(s) from order ${d.orderNumber} for ${d.sellerName}.`)}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Items", itemLines.join("; ") || "—", { last: true }),
    )}
    ${button("View your returns", d.returnsUrl)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason: `You're receiving this because you manage a seller account on ${d.brand}.` }),
    text: textBody([
      "A return was received",
      ``,
      `Axiaro received the returned item(s) from order ${d.orderNumber} for ${d.sellerName}.`,
      ``,
      `Return: ${d.returnNumber}`,
      `Order: ${d.orderNumber}`,
      `Items: ${itemLines.join("; ") || "—"}`,
      ``,
      `Your returns: ${d.returnsUrl}`,
      ...textFooter(d.brand, d.siteUrl, `You're receiving this because you manage a seller account on ${d.brand}.`),
    ]),
  };
}
