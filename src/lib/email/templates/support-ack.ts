import { layout, heading, paragraph, infoBox, kvRow, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Customer acknowledgement for a contact-form message (Step 21 P5). Confirms we
 * received the message and sets a response expectation. Sent from no-reply@ —
 * it carries no account data, no order data, no token or secret, only the
 * customer's own subject line echoed back.
 */

export type SupportAckData = {
  brand: string;
  siteUrl: string;
  customerName: string;
  subject: string;
  responseWindow: string; // e.g. "1–2 business days"
};

export function renderSupportAck(d: SupportAckData) {
  const subject = `We've received your message`;
  const reason = reasonFor("support", d.brand);

  const body = `
    ${heading("Thanks for getting in touch")}
    ${paragraph(`Hi ${d.customerName}, we've received your message and a member of our team will get back to you within ${d.responseWindow}.`)}
    ${infoBox(kvRow("Your subject", d.subject, { last: true }))}
    ${paragraph("There's nothing more you need to do — we'll reply to this email address. Please don't reply to this message; it's sent from an unmonitored address.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `Thanks for getting in touch — we'll reply within ${d.responseWindow}.`,
    reason,
  });

  const text = textBody([
    `Thanks for getting in touch`,
    ``,
    `Hi ${d.customerName}, we've received your message and a member of our team will`,
    `get back to you within ${d.responseWindow}.`,
    ``,
    `Your subject: ${d.subject}`,
    ``,
    `There's nothing more you need to do — we'll reply to this email address.`,
    `Please don't reply to this message; it's sent from an unmonitored address.`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
