import { layout, heading, paragraph, button, infoBox, kvRow, textBody, textFooter } from "@/lib/email/html";

/**
 * Seller order/return notifications (Phase 9F-7b).
 *
 * Recipients are the seller's ACTIVE OWNER / MANAGER members (+
 * `Seller.notifyEmail`) — same audience as the account/profile lifecycle
 * emails (9F-6b). Both events here are triggered by an ADMIN action on behalf
 * of the seller (parent-order cancellation; an admin marking a return
 * received) — never by the seller's own action, so there is no "you just did
 * this" redundancy.
 */

type SellerOrderBase = {
  brand: string;
  siteUrl: string;
  sellerName: string;
  orderNumber: string;
  ordersUrl: string;
};

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
