/**
 * Store settings foundation — the *schema* of what is configurable, as plain
 * data. Safe to import anywhere (server, client, seed scripts).
 *
 * The *values* live in the `StoreSetting` key/value table. Nothing about a
 * specific business is baked into application logic — a different brand can be
 * deployed by changing seed values only.
 *
 * Sensitive integration credentials (payment API keys, SMTP passwords, …) are
 * deliberately NOT part of this registry — they stay in server-side environment
 * variables and are never written to the database or sent to the browser.
 */

export type SettingType =
  | "string"
  | "text"
  | "number"
  | "boolean"
  | "url"
  | "email"
  | "media" // a MediaAsset id (picked from the media library)
  | "json";

export type SettingGroupKey =
  | "identity"
  | "storefront"
  | "contact"
  | "business"
  | "regional"
  | "social"
  | "seo"
  | "payments"
  | "shipping"
  | "returns"
  | "email";

export type SettingField = {
  key: string;
  label: string;
  type: SettingType;
  group: SettingGroupKey;
  /** Applied when the row is absent. */
  default: unknown;
  help?: string;
};

export const SETTING_GROUPS: Record<
  SettingGroupKey,
  { label: string; description: string }
> = {
  identity: { label: "Store identity", description: "Name, description and status." },
  storefront: {
    label: "Storefront content",
    description: "Global marketing copy shown across the storefront (not per-page).",
  },
  contact: { label: "Contact", description: "How customers and couriers reach the store." },
  business: { label: "Business", description: "Legal entity and registration details." },
  regional: { label: "Regional", description: "Currency, time zone and locale." },
  social: { label: "Social links", description: "Public profiles linked in the storefront." },
  seo: { label: "SEO defaults", description: "Fallback metadata for pages without their own." },
  payments: {
    label: "Payments",
    description: "Non-sensitive payment configuration. Secrets stay in the server environment.",
  },
  shipping: { label: "Shipping", description: "Default rates and thresholds." },
  returns: {
    label: "Returns",
    description: "Return window and the instructions sent when a return is approved.",
  },
  email: {
    label: "Email",
    description: "Sender identity. Provider credentials stay in the server environment.",
  },
};

export const SETTINGS_REGISTRY: SettingField[] = [
  // Identity
  { key: "store.name", label: "Store name", type: "string", group: "identity", default: "", help: "Legal / system name." },
  { key: "store.brand", label: "Display name", type: "string", group: "identity", default: "", help: "Shown in the UI and page titles." },
  { key: "store.tagline", label: "Tagline", type: "string", group: "identity", default: "" },
  { key: "store.description", label: "Description", type: "text", group: "identity", default: "" },
  { key: "store.status", label: "Store status", type: "string", group: "identity", default: "open", help: "open | maintenance | closed" },
  { key: "store.logoMediaId", label: "Logo", type: "media", group: "identity", default: "", help: "Storefront logo. Leave blank to use the built-in AXIARO mark." },
  { key: "store.faviconMediaId", label: "Favicon", type: "media", group: "identity", default: "", help: "Browser-tab icon (square PNG recommended). Blank uses the built-in icon." },

  // Storefront content
  {
    key: "storefront.announcements",
    label: "Announcement bar messages",
    type: "text",
    group: "storefront",
    default: "",
    help: "One message per line for the scrolling bar at the top of every page. Leave blank to hide the bar. Plain text only — no HTML.",
  },
  {
    key: "storefront.pdpShipping",
    label: "Product page — Shipping & returns",
    type: "text",
    group: "storefront",
    default: "",
    help: "Shown in the “Shipping & returns” panel on every product page. Markdown links allowed. This is display copy only — it does not set actual shipping rates or return rules.",
  },
  {
    key: "storefront.pdpGuarantee",
    label: "Product page — Our guarantee",
    type: "text",
    group: "storefront",
    default: "",
    help: "Shown in the “Our guarantee” panel on every product page. Leave blank to hide the panel.",
  },
  { key: "storefront.collectionAllTitle", label: "Collection — “All products” heading", type: "string", group: "storefront", default: "" },
  { key: "storefront.collectionAllText", label: "Collection — “All products” description", type: "text", group: "storefront", default: "" },
  { key: "storefront.collectionNewTitle", label: "Collection — “New In” heading", type: "string", group: "storefront", default: "" },
  { key: "storefront.collectionNewText", label: "Collection — “New In” description", type: "text", group: "storefront", default: "" },
  { key: "storefront.collectionSaleTitle", label: "Collection — “Sale” heading", type: "string", group: "storefront", default: "" },
  { key: "storefront.collectionSaleText", label: "Collection — “Sale” description", type: "text", group: "storefront", default: "" },

  // Contact
  { key: "contact.email", label: "Support email", type: "email", group: "contact", default: "", help: "Public support address shown on the contact page." },
  { key: "support.inboxEmail", label: "Contact-form inbox", type: "email", group: "contact", default: "support@axiaro.shop", help: "Internal address that contact-form submissions are delivered to. Not shown publicly." },
  { key: "contact.phone", label: "Phone", type: "string", group: "contact", default: "" },
  { key: "contact.addressLine1", label: "Address line 1", type: "string", group: "contact", default: "" },
  { key: "contact.addressLine2", label: "Address line 2", type: "string", group: "contact", default: "" },
  { key: "contact.city", label: "City", type: "string", group: "contact", default: "" },
  { key: "contact.country", label: "Country", type: "string", group: "contact", default: "" },
  { key: "contact.hours", label: "Operating hours", type: "text", group: "contact", default: "", help: "Shown on the contact page. Free text, e.g. 'Mon–Fri 9am–6pm'." },

  // Business
  { key: "business.legalName", label: "Legal name", type: "string", group: "business", default: "" },
  { key: "business.registrationNo", label: "Registration no.", type: "string", group: "business", default: "" },
  { key: "business.taxId", label: "Tax ID", type: "string", group: "business", default: "" },

  // Regional
  { key: "regional.currency", label: "Currency", type: "string", group: "regional", default: "PHP", help: "ISO 4217 code." },
  { key: "regional.timezone", label: "Time zone", type: "string", group: "regional", default: "Asia/Manila", help: "IANA time zone." },
  { key: "regional.locale", label: "Locale", type: "string", group: "regional", default: "en-PH" },

  // Social
  { key: "social.facebook", label: "Facebook", type: "url", group: "social", default: "" },
  { key: "social.instagram", label: "Instagram", type: "url", group: "social", default: "" },
  { key: "social.x", label: "X / Twitter", type: "url", group: "social", default: "" },
  { key: "social.tiktok", label: "TikTok", type: "url", group: "social", default: "" },
  { key: "social.youtube", label: "YouTube", type: "url", group: "social", default: "" },

  // SEO defaults
  { key: "seo.titleTemplate", label: "Title template", type: "string", group: "seo", default: "%s", help: "%s is replaced by the page title." },
  { key: "seo.defaultTitle", label: "Default title", type: "string", group: "seo", default: "" },
  { key: "seo.defaultDescription", label: "Default meta description", type: "text", group: "seo", default: "" },
  { key: "seo.ogImageMediaId", label: "Default share image", type: "media", group: "seo", default: "", help: "Media library image used when a page has no image of its own." },
  { key: "seo.indexable", label: "Allow search engine indexing", type: "boolean", group: "seo", default: true, help: "When off, robots.txt disallows all crawlers (use for staging)." },

  // Payments (non-sensitive)
  { key: "payments.enabledMethods", label: "Enabled methods", type: "json", group: "payments", default: ["COD", "CARD", "GCASH"] },
  { key: "payments.provider", label: "Card provider", type: "string", group: "payments", default: "", help: "Provider name only. API keys stay in the server environment." },
  { key: "payments.mode", label: "Mode", type: "string", group: "payments", default: "test", help: "test | live" },

  // Shipping. Per-method rates live in the ShippingMethod table (Step 11,
  // managed in /admin/shipping); these keys are store-wide policy.
  { key: "shipping.freeThreshold", label: "Free-shipping threshold (centavos)", type: "number", group: "shipping", default: 250000, help: "Order subtotal at or above which shipping is free. 0 disables free shipping." },
  { key: "shipping.countries", label: "Supported delivery countries", type: "json", group: "shipping", default: ["PH"], help: "ISO 3166-1 alpha-2 codes the store delivers to." },

  // Returns
  { key: "returns.windowDays", label: "Return window (days)", type: "number", group: "returns", default: 30, help: "How many days after delivery a customer can open a return. An admin can still assist outside this window." },
  { key: "returns.instructions", label: "Return instructions", type: "text", group: "returns", default: "", help: "Shown to the customer in the “return approved” email — e.g. the return address and how to pack the parcel. Plain text." },
  { key: "returns.policyUrl", label: "Returns policy link", type: "url", group: "returns", default: "", help: "Optional link to the full returns policy page, shown in return emails." },

  // Email (non-sensitive)
  { key: "email.fromName", label: "From name", type: "string", group: "email", default: "" },
  { key: "email.fromAddress", label: "From address", type: "email", group: "email", default: "" },
  { key: "email.provider", label: "Provider", type: "string", group: "email", default: "", help: "Provider name only. Credentials stay in the server environment." },
];

export function encodeSettingValue(value: unknown, type: SettingType): string {
  if (type === "json") return JSON.stringify(value ?? null);
  if (type === "boolean") return value ? "true" : "false";
  if (type === "number") return String(value ?? 0);
  return String(value ?? "");
}

export function decodeSettingValue(raw: string, type: SettingType): unknown {
  if (type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  if (type === "json") {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

/** Registry field keyed by its setting key. */
export const SETTING_FIELD_BY_KEY: Record<string, SettingField> = Object.fromEntries(
  SETTINGS_REGISTRY.map((f) => [f.key, f]),
);
