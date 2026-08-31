import { layout, heading, paragraph, button, infoBox, kvRow, textBody } from "@/lib/email/html";

/**
 * Password-changed security notice (Step 21 P2). Sent AFTER a successful
 * password change or reset. Contains NO password and NO reset token — only the
 * account email, when it happened, and (when safely known) a coarse device
 * summary. Its job is to let the account owner react if it wasn't them.
 */

export type PasswordChangedData = {
  brand: string;
  siteUrl: string;
  accountEmail: string;
  changedAt: Date;
  deviceSummary: string | null; // e.g. "Chrome on Windows"; null when unknown
  resetUrl: string; // forgot-password page
};

export function renderPasswordChanged(d: PasswordChangedData) {
  const subject = `Your ${d.brand} password was changed`;
  const when = d.changedAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";

  const rows =
    kvRow("Account", d.accountEmail) +
    kvRow("When", when, { last: !d.deviceSummary }) +
    (d.deviceSummary ? kvRow("Device", d.deviceSummary, { last: true }) : "");

  const body = `
    ${heading("Your password was changed")}
    ${paragraph(`The password for your ${d.brand} account was just changed.`)}
    ${infoBox(rows)}
    ${paragraph("If this was you, no action is needed.")}
    ${paragraph("If this wasn't you, reset your password now to lock the account, then review your recent orders.")}
    ${button("Reset your password", d.resetUrl)}
    ${paragraph("This is an automated security notification — please don't reply.")}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject });

  const text = textBody([
    `Your password was changed`,
    ``,
    `The password for your ${d.brand} account was just changed.`,
    ``,
    `Account: ${d.accountEmail}`,
    `When:    ${when}`,
    ...(d.deviceSummary ? [`Device:  ${d.deviceSummary}`] : []),
    ``,
    `If this was you, no action is needed.`,
    `If this wasn't you, reset your password now: ${d.resetUrl}`,
    ``,
    `This is an automated security notification — please don't reply.`,
  ]);

  return { subject, html, text };
}
