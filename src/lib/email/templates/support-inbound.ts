import { layout, heading, paragraph, infoBox, kvRow, esc, textBody } from "@/lib/email/html";

/**
 * Internal notification for a new contact-form message (Step 21 P5). Sent to the
 * store's support inbox, not to a customer. `Reply-To` is set to the customer's
 * address at dispatch time so the team can reply straight back. Uses the minimal
 * internal footer.
 *
 * Every field here is untrusted customer input — name / email / subject / message
 * all pass through `esc()`. No password, token or secret is ever included.
 */

export type SupportInboundData = {
  brand: string;
  siteUrl: string;
  name: string;
  email: string;
  subject: string;
  message: string;
  submittedAt: Date;
};

export function renderSupportInbound(d: SupportInboundData) {
  const subject = `[Contact form] ${d.subject}`;
  const when = d.submittedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const messageHtml = esc(d.message).replace(/\n/g, "<br>");

  const body = `
    ${heading("New contact-form message")}
    ${infoBox(
      kvRow("From", d.name) +
        kvRow("Email", d.email) +
        kvRow("Subject", d.subject) +
        kvRow("Received", when, { last: true }),
    )}
    <p style="margin:0 0 16px;color:#5b564f;font-size:14px;line-height:1.7;">${messageHtml}</p>
    ${paragraph("Reply directly to this email to respond to the customer.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `New contact-form message: ${d.subject}`,
    internal: true,
  });

  const text = textBody([
    `New contact-form message`,
    ``,
    `From:     ${d.name}`,
    `Email:    ${d.email}`,
    `Subject:  ${d.subject}`,
    `Received: ${when}`,
    ``,
    d.message,
    ``,
    `Reply directly to this email to respond to the customer.`,
  ]);

  return { subject, html, text };
}
