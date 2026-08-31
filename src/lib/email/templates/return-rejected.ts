import { layout, heading, paragraph, button, infoBox, kvRow, esc, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * "We can't approve this return" (Step 21 P3). Includes the admin's
 * customer-facing reason (resolutionNote). No internal staff note.
 */

export type ReturnRejectedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  supportUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  resolutionNote: string | null;
};

export function renderReturnRejected(d: ReturnRejectedData) {
  const subject = `An update on your return request`;
  const reason = reasonFor("return", d.brand);

  const reasonHtml = d.resolutionNote
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.resolutionNote).replace(/\n/g, "<br>")}</p>`
    : paragraph("Please see our returns policy for the details, or get in touch and we'll talk it through.");

  const body = `
    ${heading("About your return request")}
    ${paragraph(`Hi ${d.customerName}, we've reviewed your return request for order ${d.orderNumber} and we're not able to approve it.`)}
    ${infoBox(kvRow("Return reference", d.returnNumber) + kvRow("Order", d.orderNumber, { last: true }))}
    ${reasonHtml}
    ${paragraph("If you think this is a mistake, reply to our support team and we'll take another look.")}
    ${button("Contact support", d.supportUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `We've reviewed return ${d.returnNumber}.`,
    reason,
  });

  const text = textBody([
    `About your return request`,
    ``,
    `Hi ${d.customerName}, we've reviewed your return request for order ${d.orderNumber}`,
    `and we're not able to approve it.`,
    ``,
    `Return reference: ${d.returnNumber}`,
    `Order:            ${d.orderNumber}`,
    ``,
    d.resolutionNote || "Please see our returns policy for the details, or get in touch and we'll talk it through.",
    ``,
    `If you think this is a mistake, contact support: ${d.supportUrl}`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
