import { layout, heading, paragraph, button, infoBox, kvRow, textBody } from "@/lib/email/html";

/**
 * Email-change security notice (Step 21 P2). Sent to the account's CURRENT
 * (old) address the moment a change to a new address is requested, so the
 * current owner can intervene before the change completes. The new address gets
 * Supabase Auth's own confirmation link — that token never appears here.
 * Contains NO verification token.
 */

export type EmailChangedData = {
  brand: string;
  siteUrl: string;
  currentEmail: string;
  newEmailMasked: string; // already masked, e.g. "n***@example.com"
  requestedAt: Date;
  deviceSummary: string | null;
  resetUrl: string;
};

export function renderEmailChanged(d: EmailChangedData) {
  const subject = `Confirm the email change on your ${d.brand} account`;
  const when = d.requestedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const rows =
    kvRow("Current email", d.currentEmail) +
    kvRow("New email", d.newEmailMasked) +
    kvRow("Requested", when, { last: !d.deviceSummary }) +
    (d.deviceSummary ? kvRow("Device", d.deviceSummary, { last: true }) : "");

  const body = `
    ${heading("A request to change your account email")}
    ${paragraph(`Someone asked to change the email address on your ${d.brand} account. The change is not active yet — it needs to be confirmed from both the current and the new address.`)}
    ${infoBox(rows)}
    ${paragraph("If you requested this, follow the confirmation link we sent to the new address. Nothing else is needed here.")}
    ${paragraph("If you did NOT request this, your account may be at risk. Reset your password immediately — that also cancels any pending email change.")}
    ${button("Reset your password", d.resetUrl)}
    ${paragraph("This is an automated security notification — please don't reply.")}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject });

  const text = textBody([
    `A request to change your account email`,
    ``,
    `Someone asked to change the email address on your ${d.brand} account. The change is not active yet — it needs to be confirmed from both the current and the new address.`,
    ``,
    `Current email: ${d.currentEmail}`,
    `New email:     ${d.newEmailMasked}`,
    `Requested:     ${when}`,
    ...(d.deviceSummary ? [`Device:        ${d.deviceSummary}`] : []),
    ``,
    `If you requested this, use the confirmation link sent to the new address.`,
    `If you did NOT, reset your password now: ${d.resetUrl}`,
    ``,
    `This is an automated security notification — please don't reply.`,
  ]);

  return { subject, html, text };
}
