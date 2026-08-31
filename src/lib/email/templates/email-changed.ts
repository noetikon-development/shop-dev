import { layout, heading, paragraph, button, infoBox, kvRow, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Email-change security notice (Step 21 P2). Sent to the account's CURRENT
 * (old) address the moment a change to a new address is requested, so the
 * current owner can intervene before the change completes. The new address gets
 * Supabase Auth's own confirmation link — that token never appears here.
 * Contains NO verification token. The subject is framed as an alert about a
 * *request* because, at the time this lands, the address has not changed yet.
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
  const subject = `An email change was requested on your ${d.brand} account`;
  const when = d.requestedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const reason = reasonFor("security", d.brand);

  const rows =
    kvRow("Current email", d.currentEmail) +
    kvRow("New email", d.newEmailMasked) +
    kvRow("Requested", when, { last: !d.deviceSummary }) +
    (d.deviceSummary ? kvRow("Device", d.deviceSummary, { last: true }) : "");

  const body = `
    ${heading("A request to change your account email")}
    ${paragraph(`Someone asked to change the email address on your ${d.brand} account. The change is not active yet — it has to be confirmed from both the current and the new address.`)}
    ${infoBox(rows)}
    ${paragraph("If you requested this, open the confirmation link we sent to the new address. Nothing else is needed here.")}
    ${paragraph("If you did NOT request this, your account may be at risk. Reset your password now — that also cancels the pending email change.")}
    ${button("Reset your password", d.resetUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: "You didn't ask for this? Reset your password to cancel it.",
    reason,
    security: true,
  });

  const text = textBody([
    `A request to change your account email`,
    ``,
    `Someone asked to change the email address on your ${d.brand} account. The change is`,
    `not active yet — it has to be confirmed from both the current and the new address.`,
    ``,
    `Current email: ${d.currentEmail}`,
    `New email:     ${d.newEmailMasked}`,
    `Requested:     ${when}`,
    ...(d.deviceSummary ? [`Device:        ${d.deviceSummary}`] : []),
    ``,
    `If you requested this, use the confirmation link sent to the new address.`,
    `If you did NOT, reset your password now: ${d.resetUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
