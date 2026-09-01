import { layout, heading, paragraph, button, infoBox, kvRow, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Email-change security notice (Step 21 P2; copy fix 2026-09-01). Sent to the
 * account's CURRENT (old) address the moment a change to a new address is
 * requested.
 *
 * Supabase "Secure email change" is enabled, so the change is confirmed from
 * BOTH addresses: Supabase Auth sends its own "Confirm Email Change" email to
 * the old address AND the new address, and the change only takes effect once
 * both are confirmed. This notice does NOT carry a confirmation link — it
 * explains the security event and points the recipient at the separate Supabase
 * confirmation email that also arrived at this address. Contains NO verification
 * token. The subject is framed as an alert about a *request* because, when it
 * lands, the address has not changed yet.
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
    ${heading(`An email change was requested on your ${d.brand} account`)}
    ${paragraph(`Someone requested to change the email address on your ${d.brand} account. The change is not active yet.`)}
    ${infoBox(rows)}
    ${paragraph(`If you requested this change, a separate confirmation email has also been sent to this address. Please open that email and confirm the change. The new email address will take effect after both confirmations are completed.`)}
    ${paragraph(`If you didn't request this change, reset your password immediately. This will also cancel the pending email change.`)}
    ${button("Reset your password", d.resetUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: "Confirm from this address too — or reset your password if it wasn't you.",
    reason,
    security: true,
  });

  const text = textBody([
    `An email change was requested on your ${d.brand} account`,
    ``,
    `Someone requested to change the email address on your ${d.brand} account.`,
    `The change is not active yet.`,
    ``,
    `Current email: ${d.currentEmail}`,
    `New email:     ${d.newEmailMasked}`,
    `Requested:     ${when}`,
    ...(d.deviceSummary ? [`Device:        ${d.deviceSummary}`] : []),
    ``,
    `If you requested this change, a separate confirmation email has also been sent to`,
    `this address. Open that email and confirm the change. The new email address takes`,
    `effect after both confirmations are completed.`,
    ``,
    `If you didn't request this change, reset your password immediately — this also`,
    `cancels the pending email change: ${d.resetUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
