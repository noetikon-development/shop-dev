import { layout, heading, paragraph, button, textBody, textFooter, reasonFor, article } from "@/lib/email/html";

/**
 * Auth email templates (Batch 3 Phase 2).
 *
 * Supabase Auth owns the email verification / password reset / magic link /
 * invite / email-change flows (token generation, single-use links, expiry). The
 * **canonical branded copy for those emails lives here** — `scripts/gen-supabase-templates.ts`
 * renders these with Supabase's `{{ .ConfirmationURL }}` / `{{ .Email }}` tokens
 * so the exact HTML can be pasted into the Supabase dashboard.
 *
 * `renderEmailVerification` / `renderPasswordReset` are also exported from
 * `notifications.ts` as app-side foundations for a future operator who moves
 * these emails into the app. They are NOT wired to any application flow — do not
 * call them without a real, single-use, provider-issued link.
 */

export type AuthEmailData = {
  brand: string;
  siteUrl: string;
  actionUrl: string; // a real, single-use link — or "{{ .ConfirmationURL }}" for the Supabase template
  /** The recipient address / name — a concrete value, or "{{ .Email }}" for the Supabase template. */
  recipient?: string | null;
  firstName?: string | null;
};

function greet(d: AuthEmailData): string {
  if (d.firstName) return `Hi ${d.firstName},`;
  if (d.recipient) return `Hi ${d.recipient},`;
  return "Hi there,";
}

export function renderEmailVerification(d: AuthEmailData) {
  const subject = `Confirm your ${d.brand} email address`;
  const reason = reasonFor("account", d.brand);
  const body = `
    ${heading("Confirm your email address")}
    ${paragraph(`${greet(d)} thanks for creating your ${d.brand} account. Confirm your email address to finish setting up your account.`)}
    ${button("Confirm email address", d.actionUrl)}
    ${paragraph(`If you didn't create ${article(d.brand)} ${d.brand} account, you can ignore this email.`)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason, security: true }),
    text: textBody([
      `Confirm your email address`,
      ``,
      `${greet(d)} thanks for creating your ${d.brand} account.`,
      `Confirm your email address to finish setting up your account:`,
      ``,
      d.actionUrl,
      ``,
      `If you didn't create a ${d.brand} account, you can ignore this email.`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

export function renderPasswordReset(d: AuthEmailData) {
  const subject = `Reset your ${d.brand} password`;
  const reason = reasonFor("security", d.brand);
  const body = `
    ${heading("Reset your password")}
    ${paragraph(`${greet(d)} we received a request to reset the password for your ${d.brand} account. This link works once and expires in 1 hour.`)}
    ${button("Reset your password", d.actionUrl)}
    ${paragraph("If you didn't request this, you can ignore this email — your password won't change.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason, security: true }),
    text: textBody([
      `Reset your password`,
      ``,
      `${greet(d)} we received a request to reset the password for your ${d.brand} account.`,
      `This link works once and expires in 1 hour:`,
      ``,
      d.actionUrl,
      ``,
      `If you didn't request this, you can ignore this email — your password won't change.`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

export function renderMagicLink(d: AuthEmailData) {
  const subject = `Your ${d.brand} sign-in link`;
  const reason = reasonFor("security", d.brand);
  const body = `
    ${heading("Your sign-in link")}
    ${paragraph(`${greet(d)} use this link to sign in to your ${d.brand} account. It works once and expires shortly.`)}
    ${button(`Sign in to ${d.brand}`, d.actionUrl)}
    ${paragraph("If you didn't ask to sign in, you can ignore this email.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason, security: true }),
    text: textBody([
      `Your sign-in link`,
      ``,
      `${greet(d)} use this link to sign in to your ${d.brand} account.`,
      `It works once and expires shortly:`,
      ``,
      d.actionUrl,
      ``,
      `If you didn't ask to sign in, you can ignore this email.`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}

export function renderInvite(d: AuthEmailData) {
  const subject = `You've been invited to the ${d.brand} team`;
  const body = `
    ${heading(`You've been invited to ${d.brand}`)}
    ${paragraph(`You've been invited to join the ${d.brand} admin team. Accept the invitation to set a password and sign in.`)}
    ${button("Accept your invitation", d.actionUrl)}
    ${paragraph("If you weren't expecting this, you can ignore this email.")}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, internal: true }),
    text: textBody([
      `You've been invited to ${d.brand}`,
      ``,
      `You've been invited to join the ${d.brand} admin team.`,
      `Accept the invitation to set a password and sign in:`,
      ``,
      d.actionUrl,
      ``,
      `If you weren't expecting this, you can ignore this email.`,
      ``,
      `--`,
      `${d.brand} · internal notification`,
    ]),
  };
}

export type EmailChangeConfirmData = AuthEmailData & { newEmail: string };

export function renderEmailChangeConfirm(d: EmailChangeConfirmData) {
  const subject = `Confirm your new ${d.brand} email address`;
  const reason = reasonFor("security", d.brand);
  const body = `
    ${heading("Confirm your new email address")}
    ${paragraph(`You asked to change your ${d.brand} email${d.recipient ? ` from ${d.recipient}` : ""} to ${d.newEmail}. Confirm from this address to continue — you'll also need to confirm from the other one.`)}
    ${button("Confirm the change", d.actionUrl)}
    ${paragraph(`If you didn't request this, ignore this email and consider resetting your ${d.brand} password.`)}
  `;
  return {
    subject,
    html: layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: subject, reason, security: true }),
    text: textBody([
      `Confirm your new email address`,
      ``,
      `You asked to change your ${d.brand} email${d.recipient ? ` from ${d.recipient}` : ""} to ${d.newEmail}.`,
      `Confirm from this address to continue — you'll also need to confirm from the other one:`,
      ``,
      d.actionUrl,
      ``,
      `If you didn't request this, ignore this email and consider resetting your ${d.brand} password.`,
      ...textFooter(d.brand, d.siteUrl, reason),
    ]),
  };
}
