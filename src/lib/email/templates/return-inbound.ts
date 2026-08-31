import { layout, heading, paragraph, infoBox, kvRow, esc, textBody } from "@/lib/email/html";
import { returnItemsHtml, returnItemsText, type ReturnEmailItem } from "@/lib/email/templates/_return-shared";

/**
 * Internal "a return needs triage" notification (Step 21 P3). Sent to the
 * support inbox, NOT to a customer. From orders@axiaro.shop; Reply-To is set to
 * the customer's address at dispatch. Carries the customer's own note (escaped)
 * — never a staff note, token or secret.
 */

export type ReturnInboundData = {
  brand: string;
  siteUrl: string;
  adminUrl: string;
  returnNumber: string;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  reasonLabel: string;
  customerNote: string | null;
  adminAssisted: boolean;
  items: ReturnEmailItem[];
};

export function renderReturnInbound(d: ReturnInboundData) {
  const subject = `[Return] ${d.returnNumber} — order ${d.orderNumber}`;
  const noteHtml = d.customerNote
    ? `<p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${esc(d.customerNote).replace(/\n/g, "<br>")}</p>`
    : `<p style="margin:0 0 16px;color:#8a847a;font-size:14px;">No note from the customer.</p>`;

  const body = `
    ${heading("New return request")}
    ${infoBox(
      kvRow("Return", d.returnNumber) +
        kvRow("Order", d.orderNumber) +
        kvRow("Customer", d.customerName) +
        kvRow("Email", d.customerEmail) +
        kvRow("Reason", d.reasonLabel) +
        kvRow("Raised by", d.adminAssisted ? "Admin (assisted)" : "Customer", { last: true }),
    )}
    ${paragraph("Items requested for return:")}
    ${returnItemsHtml(d.items)}
    ${paragraph("Customer note:")}
    ${noteHtml}
    ${paragraph("Open it in the admin to approve, reject or process.")}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject });

  const text = textBody([
    `New return request`,
    ``,
    `Return:    ${d.returnNumber}`,
    `Order:     ${d.orderNumber}`,
    `Customer:  ${d.customerName} <${d.customerEmail}>`,
    `Reason:    ${d.reasonLabel}`,
    `Raised by: ${d.adminAssisted ? "Admin (assisted)" : "Customer"}`,
    ``,
    `Items:`,
    ...returnItemsText(d.items),
    ``,
    `Customer note:`,
    d.customerNote || "(none)",
    ``,
    `Admin: ${d.adminUrl}`,
  ]);

  return { subject, html, text };
}
