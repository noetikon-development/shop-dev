import { layout, heading, paragraph, button, infoBox, kvRow, esc, textBody } from "@/lib/email/html";
import { returnItemsHtml, returnItemsText, type ReturnEmailItem } from "@/lib/email/templates/_return-shared";

/**
 * "Your return has been approved" (Step 21 P3). Includes the return
 * instructions from Store Settings (returns.instructions) and an optional
 * admin-written resolution note. No token / secret / staff note.
 */

export type ReturnApprovedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  items: ReturnEmailItem[];
  instructions: string | null; // returns.instructions setting
  policyUrl: string | null;
  resolutionNote: string | null; // customer-facing admin note
};

export function renderReturnApproved(d: ReturnApprovedData) {
  const subject = `Your return ${d.returnNumber} is approved — ${d.brand}`;

  const instructionsHtml = d.instructions
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.instructions).replace(/\n/g, "<br>")}</p>`
    : paragraph("We'll be in touch shortly with where to send the items.");
  const noteHtml = d.resolutionNote
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.resolutionNote).replace(/\n/g, "<br>")}</p>`
    : "";

  const body = `
    ${heading("Your return is approved")}
    ${paragraph(`Hi ${d.customerName}, we've approved your return for order ${d.orderNumber}.`)}
    ${infoBox(kvRow("Return reference", d.returnNumber) + kvRow("Order", d.orderNumber, { last: true }))}
    ${paragraph("Approved items:")}
    ${returnItemsHtml(d.items)}
    ${noteHtml}
    ${heading("How to send your return")}
    ${instructionsHtml}
    ${paragraph("Once we receive and check the items we'll email you again about your refund.")}
    ${button("View your return", d.returnUrl)}
    ${d.policyUrl ? paragraph(`Full returns policy: ${d.policyUrl}`) : ""}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Your return ${d.returnNumber} is approved`,
  });

  const text = textBody([
    `Your return is approved`,
    ``,
    `Hi ${d.customerName}, we've approved your return for order ${d.orderNumber}.`,
    ``,
    `Return reference: ${d.returnNumber}`,
    `Order:            ${d.orderNumber}`,
    ``,
    `Approved items:`,
    ...returnItemsText(d.items),
    ``,
    ...(d.resolutionNote ? [d.resolutionNote, ``] : []),
    `How to send your return:`,
    d.instructions || "We'll be in touch shortly with where to send the items.",
    ``,
    `Once we receive and check the items we'll email you again about your refund.`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...(d.policyUrl ? [`Full returns policy: ${d.policyUrl}`] : []),
  ]);

  return { subject, html, text };
}
