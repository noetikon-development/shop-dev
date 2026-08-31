import { layout, heading, paragraph, button, infoBox, kvRow, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * New-device sign-in alert (Step 21 P2). Sent only when a successful password
 * sign-in comes from a device (user-agent) we have not seen for this account
 * before — never on session refresh or a page request. Contains NO password,
 * NO access token, NO refresh token: only a coarse device summary and the time.
 */

export type SignInAlertData = {
  brand: string;
  siteUrl: string;
  accountEmail: string;
  signedInAt: Date;
  deviceSummary: string; // e.g. "Safari on iPhone" / "Unknown device"
  resetUrl: string;
};

export function renderSignInAlert(d: SignInAlertData) {
  const subject = `New sign-in to your ${d.brand} account`;
  const when = d.signedInAt.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  const reason = reasonFor("security", d.brand);

  const body = `
    ${heading("New sign-in to your account")}
    ${paragraph(`Your ${d.brand} account was just signed in to from a device we haven't seen before.`)}
    ${infoBox(
      kvRow("Account", d.accountEmail) +
        kvRow("Device", d.deviceSummary) +
        kvRow("When", when, { last: true }),
    )}
    ${paragraph("If this was you, you can ignore this message — we won't email you again for this device.")}
    ${paragraph("If this wasn't you, reset your password now to secure the account.")}
    ${button("Reset your password", d.resetUrl)}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: `${d.deviceSummary} · ${when}. Not you? Reset your password.`,
    reason,
    security: true,
  });

  const text = textBody([
    `New sign-in to your account`,
    ``,
    `Your ${d.brand} account was just signed in to from a device we haven't seen before.`,
    ``,
    `Account: ${d.accountEmail}`,
    `Device:  ${d.deviceSummary}`,
    `When:    ${when}`,
    ``,
    `If this was you, you can ignore this message.`,
    `If this wasn't you, reset your password now: ${d.resetUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
