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
  | "json";

export type SettingGroupKey =
  | "identity"
  | "contact"
  | "business"
  | "regional"
  | "social"
  | "seo"
  | "payments"
  | "shipping"
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
  { key: "store.logoMediaId", label: "Logo", type: "string", group: "identity", default: "", help: "MediaAsset id, set from the media library later." },
  { key: "store.faviconMediaId", label: "Favicon", type: "string", group: "identity", default: "" },

  // Contact
  { key: "contact.email", label: "Support email", type: "email", group: "contact", default: "" },
  { key: "contact.phone", label: "Phone", type: "string", group: "contact", default: "" },
  { key: "contact.addressLine1", label: "Address line 1", type: "string", group: "contact", default: "" },
  { key: "contact.addressLine2", label: "Address line 2", type: "string", group: "contact", default: "" },
  { key: "contact.city", label: "City", type: "string", group: "contact", default: "" },
  { key: "contact.country", label: "Country", type: "string", group: "contact", default: "" },

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
  { key: "social.tiktok", label: "TikTok", type: "url", group: "social", default: "" },
  { key: "social.youtube", label: "YouTube", type: "url", group: "social", default: "" },

  // SEO defaults
  { key: "seo.titleTemplate", label: "Title template", type: "string", group: "seo", default: "%s", help: "%s is replaced by the page title." },
  { key: "seo.defaultTitle", label: "Default title", type: "string", group: "seo", default: "" },
  { key: "seo.defaultDescription", label: "Default meta description", type: "text", group: "seo", default: "" },
  { key: "seo.ogImageMediaId", label: "Default share image", type: "string", group: "seo", default: "" },

  // Payments (non-sensitive)
  { key: "payments.enabledMethods", label: "Enabled methods", type: "json", group: "payments", default: ["COD", "CARD", "GCASH"] },
  { key: "payments.provider", label: "Card provider", type: "string", group: "payments", default: "", help: "Provider name only. API keys stay in the server environment." },
  { key: "payments.mode", label: "Mode", type: "string", group: "payments", default: "test", help: "test | live" },

  // Shipping
  { key: "shipping.freeThreshold", label: "Free-shipping threshold (centavos)", type: "number", group: "shipping", default: 250000 },
  { key: "shipping.standardFee", label: "Standard fee (centavos)", type: "number", group: "shipping", default: 12900 },
  { key: "shipping.expressFee", label: "Express fee (centavos)", type: "number", group: "shipping", default: 24900 },

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
