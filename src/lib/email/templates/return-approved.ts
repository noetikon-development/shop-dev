import { layout, heading, paragraph, button, infoBox, kvRow, esc, textBody, textFooter, reasonFor } from "@/lib/email/html";
import { returnItemsHtml, returnItemsText, type ReturnEmailItem } from "@/lib/email/templates/_return-shared";

/**
 * "Your return has been approved" (Step 21 P3; 9F-41B routing).
 *
 * 9F-41B: `destination*` is the resolved + frozen return destination —
 *   - a single-3P-seller return with an approved address → the seller's address;
 *   - otherwise the store-wide `returns.instructions` (unchanged behaviour).
 * `destinationLines` empty + `destinationNote` set = "we'll email you the
 * address" — the pre-9F-41B fallback wording is preserved by the caller.
 *
 * No token / secret / staff note.
 */

export type ReturnApprovedData = {
  brand: string;
  siteUrl: string;
  returnUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  items: ReturnEmailItem[];
  destinationHeading: string; // e.g. "How to send your return" / "Send your return to <seller>"
  destinationLines: string[]; // address / instruction lines (already plain text)
  destinationNote: string | null; // seller returnPolicy, or a fallback sentence
  policyUrl: string | null;
  resolutionNote: string | null; // customer-facing admin note
};

export function renderReturnApproved(d: ReturnApprovedData) {
  const subject = `Your return has been approved`;
  const reason = reasonFor("return", d.brand);

  const destinationHtml =
    d.destinationLines.length > 0
      ? `<p style="margin:0 0 12px;color:#5b564f;font-size:14px;line-height:1.7;">${d.destinationLines
          .map((l) => esc(l))
          .join("<br>")}</p>`
      : paragraph(d.destinationNote ?? "We'll be in touch shortly with where to send the items.");
  const destinationNoteHtml =
    d.destinationLines.length > 0 && d.destinationNote
      ? `<p style="margin:0 0 16px;color:#5b564f;font-size:13px;line-height:1.7;">${esc(d.destinationNote).replace(/\n/g, "<br>")}</p>`
      : "";
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
    ${heading(d.destinationHeading)}
    ${destinationHtml}
    ${destinationNoteHtml}
    ${paragraph("Once we receive and check the items we'll email you again about your refund.")}
    ${button("View your return", d.returnUrl)}
    ${d.policyUrl ? paragraph(`Full returns policy: ${d.policyUrl}`) : ""}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Return ${d.returnNumber} approved — how to send it back.`,
    reason,
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
    `${d.destinationHeading}:`,
    ...(d.destinationLines.length > 0
      ? d.destinationLines
      : [d.destinationNote ?? "We'll be in touch shortly with where to send the items."]),
    ...(d.destinationLines.length > 0 && d.destinationNote ? [``, d.destinationNote] : []),
    ``,
    `Once we receive and check the items we'll email you again about your refund.`,
    ``,
    `View your return: ${d.returnUrl}`,
    ...(d.policyUrl ? [`Full returns policy: ${d.policyUrl}`] : []),
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
