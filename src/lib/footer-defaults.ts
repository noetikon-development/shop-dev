import type { FooterData } from "@/lib/content-blocks";

/** The single site-footer ContentBlock. */
export const FOOTER_BLOCK_KEY = "footer.default";

export type FooterActionState = { ok?: boolean; error?: string };

/**
 * Built-in footer content (Phase 5A).
 *
 * Used as the storefront fallback when the `footer.default` ContentBlock is
 * absent / unpublished / unreachable, and offered in the admin editor as the
 * "reset to defaults" starting point. Pure data — safe to import anywhere.
 *
 * Authoritative business values (support email, social URLs, legal name) are
 * NOT here — the footer component merges those in from Store Settings.
 */
export const FOOTER_DEFAULTS: FooterData = {
  brandDescription: "",
  newsletter: {
    heading: "Get 10% off your first order",
    body: "",
    ctaLabel: "",
    successText: "Use code WELCOME10 at checkout for 10% off your first order.",
  },
  shopColumn: { heading: "Shop", links: [] },
  helpColumn: {
    heading: "Help",
    links: [
      { label: "Track your order", href: "/track", enabled: true },
      { label: "Shipping & delivery", href: "/pages/shipping", enabled: true },
      { label: "Returns & refunds", href: "/pages/returns", enabled: true },
      { label: "Assembly & care", href: "/pages/care", enabled: true },
      { label: "FAQ", href: "/pages/faq", enabled: true },
      { label: "Contact us", href: "/pages/contact", enabled: true },
    ],
  },
  companyColumn: {
    heading: "Company",
    links: [{ label: "About us", href: "/pages/about", enabled: true }],
  },
  legalLinks: [
    { label: "Privacy", href: "/pages/privacy", enabled: true },
    { label: "Terms", href: "/pages/terms", enabled: true },
    { label: "Cookies", href: "/pages/cookies", enabled: true },
    { label: "Cancellation", href: "/pages/cancellation", enabled: true },
  ],
  copyright: "© {year} {brand}. All rights reserved.",
};
