import { layout, heading, paragraph, button, infoBox, kvRow, textBody, textFooter, reasonFor } from "@/lib/email/html";
import { returnItemsHtml, returnItemsText, type ReturnEmailItem } from "@/lib/email/templates/_return-shared";

/**
 * "We've received your return request" (Step 21 P3). Sent to the customer the
 * moment a return is opened. No refund is promised here — the request still
 * needs review.
 */

export type ReturnRequestedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  reasonLabel: string;
  items: ReturnEmailItem[];
};

export function renderReturnRequested(d: ReturnRequestedData) {
  const subject = `We've received your return request`;
  const reason = reasonFor("return", d.brand);

  const body = `
    ${heading("Your return request is in")}
    ${paragraph(`Hi ${d.customerName}, thanks — we've received your request to return part of order ${d.orderNumber}. Our team will review it and email you the next steps, usually within 1–2 business days.`)}
    ${infoBox(
      kvRow("Return reference", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Reason", d.reasonLabel, { last: true }),
    )}
    ${paragraph("Items you asked to return:")}
    ${returnItemsHtml(d.items)}
    ${paragraph("Please keep the items in their original condition and packaging until your return is approved.")}
    ${button("View your return", d.returnUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Return ${d.returnNumber} for order ${d.orderNumber} — we'll reply within 1–2 business days.`,
    reason,
  });

  const text = textBody([
    `Your return request is in`,
    ``,
    `Hi ${d.customerName}, we've received your request to return part of order ${d.orderNumber}.`,
    `Our team will review it and email you the next steps, usually within 1-2 business days.`,
    ``,
    `Return reference: ${d.returnNumber}`,
    `Order:            ${d.orderNumber}`,
    `Reason:           ${d.reasonLabel}`,
    ``,
    `Items:`,
    ...returnItemsText(d.items),
    ``,
    `Please keep the items in their original condition and packaging until your return is approved.`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
