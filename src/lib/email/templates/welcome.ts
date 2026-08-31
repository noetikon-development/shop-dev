import { layout, heading, paragraph, button, textLink, textBody, textFooter, reasonFor } from "@/lib/email/html";

/**
 * Welcome email (Step 17 §5; Batch 3 Phase 2). Sent once per customer
 * (idempotency key WELCOME:<userId>) after their first confirmed sign-in.
 * Contains only the store name, the customer's first name, a short welcome and
 * links — no sensitive information.
 */

export type WelcomeData = {
  brand: string;
  siteUrl: string;
  accountUrl: string;
  firstName: string | null;
};

export function renderWelcome(d: WelcomeData) {
  const subject = `Welcome to ${d.brand}`;
  const hi = d.firstName ? `Hi ${d.firstName},` : "Hi there,";
  const reason = reasonFor("account", d.brand);

  const body = `
    ${heading(`Welcome to ${d.brand}`)}
    ${paragraph(`${hi} thanks for creating an account. From here you can track every order, save delivery addresses, keep a wishlist and start a return — all in one place.`)}
    ${button("Go to your account", d.accountUrl)}
    ${textLink("or browse the shop", d.siteUrl)}
    ${paragraph("We design our pieces in-house and price them without the markup. Free delivery on orders over ₱2,500.")}
  `;

  const html = layout(body, {
    brand: d.brand,
    siteUrl: d.siteUrl,
    previewText: "Your account is ready — orders, addresses and your wishlist in one place.",
    reason,
  });

  const text = textBody([
    `Welcome to ${d.brand}`,
    ``,
    `${hi} thanks for creating an account. From here you can track every order, save`,
    `delivery addresses, keep a wishlist and start a return — all in one place.`,
    ``,
    `Your account: ${d.accountUrl}`,
    `Browse the shop: ${d.siteUrl}`,
    ...textFooter(d.brand, d.siteUrl, reason),
  ]);

  return { subject, html, text };
}
