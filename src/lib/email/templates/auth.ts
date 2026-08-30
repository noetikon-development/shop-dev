import { layout, heading, paragraph, button, textBody } from "@/lib/email/html";

/**
 * Auth email templates — FOUNDATION ONLY (Step 17 §3 / §4 / §43).
 *
 * Email verification and password reset are handled by **Supabase Auth**, which
 * owns those flows (token generation, single-use links, expiry). These templates
 * and the `sendEmailVerification` / `sendPasswordReset` functions in
 * `notifications.ts` are NOT wired to any application flow — they exist so a
 * future operator who chooses to move those emails into the app (e.g. custom
 * SMTP outside Supabase) has a consistent, branded starting point. Do not call
 * them without a real, single-use token from an auth provider.
 */

export type AuthEmailData = {
  brand: string;
  siteUrl: string;
  actionUrl: string; // a real, single-use, provider-issued link
  firstName: string | null;
};

export function renderEmailVerification(d: AuthEmailData) {
  const subject = `Confirm your email for ${d.brand}`;
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi,";
  const body = `
    ${heading("Confirm your email address")}
    ${paragraph(`${hi} please confirm this is your email address to finish setting up your ${d.brand} account.`)}
    ${button("Confirm email", d.actionUrl)}
    ${paragraph("If you didn't create an account, you can ignore this message.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject }),
    text: textBody([
      `Confirm your email address`,
      ``,
      `${hi} please confirm this is your email address to finish setting up your ${d.brand} account.`,
      ``,
      `Confirm: ${d.actionUrl}`,
      ``,
      `If you didn't create an account, you can ignore this message.`,
    ]),
  };
}

export function renderPasswordReset(d: AuthEmailData) {
  const subject = `Reset your ${d.brand} password`;
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi,";
  const body = `
    ${heading("Reset your password")}
    ${paragraph(`${hi} we received a request to reset your ${d.brand} password. This link works once and expires shortly.`)}
    ${button("Reset password", d.actionUrl)}
    ${paragraph("If you didn't request this, you can ignore this message — your password won't change.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject }),
    text: textBody([
      `Reset your password`,
      ``,
      `${hi} we received a request to reset your ${d.brand} password. This link works once and expires shortly.`,
      ``,
      `Reset: ${d.actionUrl}`,
      ``,
      `If you didn't request this, you can ignore this message.`,
    ]),
  };
}
