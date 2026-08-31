import { layout, heading, paragraph, button, infoBox, kvRow, textBody } from "@/lib/email/html";
import { returnItemsHtml, returnItemsText, type ReturnEmailItem } from "@/lib/email/templates/_return-shared";

/**
 * "We've received your returned items" (Step 21 P3). Fired on
 * APPROVED → RECEIVED. Sets the expectation that a refund follows; makes no
 * claim about the refund amount yet.
 */

export type ReturnReceivedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  items: ReturnEmailItem[];
};

export function renderReturnReceived(d: ReturnReceivedData) {
  const subject = `We've received your return ${d.returnNumber} — ${d.brand}`;

  const body = `
    ${heading("Your return has arrived")}
    ${paragraph(`Hi ${d.customerName}, we've received the items from your return for order ${d.orderNumber} and checked them in.`)}
    ${infoBox(kvRow("Return reference", d.returnNumber) + kvRow("Order", d.orderNumber, { last: true }))}
    ${returnItemsHtml(d.items)}
    ${paragraph("We'll process your refund next and email you once it's on its way.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `We've received your return ${d.returnNumber}`,
  });

  const text = textBody([
    `Your return has arrived`,
    ``,
    `Hi ${d.customerName}, we've received the items from your return for order ${d.orderNumber}`,
    `and checked them in.`,
    ``,
    `Return reference: ${d.returnNumber}`,
    `Order:            ${d.orderNumber}`,
    ``,
    ...returnItemsText(d.items),
    ``,
    `We'll process your refund next and email you once it's on its way.`,
    ``,
    `View your return: ${d.returnUrl}`,
  ]);

  return { subject, html, text };
}
