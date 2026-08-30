import { layout, heading, paragraph, button, textBody } from "@/lib/email/html";

/**
 * Welcome email (Step 17 §5). Sent once per customer (idempotency key
 * WELCOME:<userId>). Contains only the store name, the customer's first name,
 * a short welcome and links — no sensitive information.
 */

export type WelcomeData = {
  brand: string;
  siteUrl: string;
  accountUrl: string;
  firstName: string | null;
};

export function renderWelcome(d: WelcomeData) {
  const subject = `Welcome to ${d.brand}`;
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi,";

  const body = `
    ${heading(`Welcome to ${d.brand}`)}
    ${paragraph(`${hi} thanks for creating an account. Your orders, addresses and wishlist now live in one place.`)}
    ${button("Go to your account", d.accountUrl)}
    ${paragraph("Have a look around whenever you're ready — we design our pieces in-house and price them without the markup.")}
    ${button("Start shopping", d.siteUrl)}
  `;

  const html = layout(body, { brand: d.brand, siteUrl: d.siteUrl, previewText: `Welcome to ${d.brand}` });

  const text = textBody([
    `Welcome to ${d.brand}`,
    ``,
    `${hi} thanks for creating an account. Your orders, addresses and wishlist now live in one place.`,
    ``,
    `Your account: ${d.accountUrl}`,
    `Start shopping: ${d.siteUrl}`,
  ]);

  return { subject, html, text };
}
