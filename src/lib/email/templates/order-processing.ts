import { layout, heading, paragraph, button, infoBox, kvRow, esc, textBody } from "@/lib/email/html";

/**
 * "Preparing your order" notification (Step 21 P1). Fired when an admin moves an
 * order to PROCESSING. Deliberately concise — order number, what's being packed,
 * and a link. No courier / tracking yet (the order has not shipped), no prices,
 * no payment claim (the full breakdown lives in the confirmation email).
 */

export type OrderProcessingData = {
  brand: string;
  siteUrl: string;
  orderUrl: string;
  orderNumber: string;
  customerName: string;
  items: { name: string; variantLabel: string | null; quantity: number }[];
};

export function renderOrderProcessing(d: OrderProcessingData) {
  const subject = `Order ${d.orderNumber} is being prepared — ${d.brand}`;
  const totalUnits = d.items.reduce((n, i) => n + i.quantity, 0);
  const itemSummary = `${totalUnits} item${totalUnits === 1 ? "" : "s"}`;

  const listLines = d.items.map(
    (i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`,
  );
  const listHtml = `<p style="margin:0 0 18px;color:#5b564f;font-size:13px;line-height:1.7;">${listLines
    .map((l) => esc(l))
    .join("<br>")}</p>`;

  const body = `
    ${heading("We're preparing your order")}
    ${paragraph(`Hi ${d.customerName}, good news — your order is being picked and packed. We'll email you again the moment it ships.`)}
    ${infoBox(kvRow("Order number", d.orderNumber) + kvRow("Items", itemSummary, { last: true }))}
    ${listHtml}
    ${button("View your order", d.orderUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Order ${d.orderNumber} is being prepared`,
  });

  const text = textBody([
    `We're preparing your order`,
    ``,
    `Hi ${d.customerName}, your order is being picked and packed. We'll email you again when it ships.`,
    ``,
    `Order number: ${d.orderNumber}`,
    `Items:        ${itemSummary}`,
    ``,
    ...listLines.map((l) => `- ${l}`),
    ``,
    `View your order: ${d.orderUrl}`,
  ]);

  return { subject, html, text };
}
