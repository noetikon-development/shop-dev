/**
 * CMS-customizable email template registry (Phase 9F-57).
 *
 * Plain data — safe to import from server and client (the admin editor reads
 * `label` / `allowedTokens` / etc. to build its form). This is NOT a second
 * email framework: it is a fixed catalogue of the templates that MAY be
 * overridden through the existing `ContentBlock` CMS (see
 * `src/lib/email/template-overrides.ts` for the resolver, and
 * `src/lib/content-blocks.ts` for the `email_template` block schema).
 *
 * A template key here is a CMS-addressing concept, not always identical to the
 * dispatched `EmailType` (`src/lib/email/send.ts`) — `seller_product_request_rejected`
 * and `seller_product_request_changes_requested` are two distinct CMS templates
 * (different default copy, different admin-editable fields) that both dispatch
 * under the SAME EmailType `seller_product_request_rejected` (the existing
 * `outcome` branch already used by `sendSellerProductRequestRejected`).
 */

export const EMAIL_TOKENS = [
  "sellerName",
  "storeName",
  "orderNumber",
  "productName",
  "status",
  "reason",
  "carrier",
  "trackingNumber",
  "refundAmount",
  "settlementAmount",
  "actionUrl",
] as const;

export type EmailToken = (typeof EMAIL_TOKENS)[number];

export function isEmailToken(v: string): v is EmailToken {
  return (EMAIL_TOKENS as readonly string[]).includes(v);
}

export const EMAIL_TEMPLATE_CATEGORIES = [
  "seller_lifecycle",
  "product_lifecycle",
  "order_fulfilment",
  "post_order",
  "payment",
] as const;
export type EmailTemplateCategory = (typeof EMAIL_TEMPLATE_CATEGORIES)[number];

export const EMAIL_TEMPLATE_CATEGORY_LABELS: Record<EmailTemplateCategory, string> = {
  seller_lifecycle: "Seller lifecycle",
  product_lifecycle: "Product lifecycle",
  order_fulfilment: "Order / fulfilment",
  post_order: "Post-order",
  payment: "Payment (PayMongo)",
};

export type EmailTemplateDef = {
  /** CMS key (ContentBlock.key = `email.<key>`). */
  key: string;
  label: string;
  category: EmailTemplateCategory;
  description: string;
  /** Tokens this template's admin editor offers / that render() will substitute. */
  allowedTokens: EmailToken[];
  /** Whether the template renders an action button (uses {{actionUrl}}). */
  hasActionButton: boolean;
  /** Whether the "Optional additional message" field applies to this template. */
  hasExtraMessage: boolean;
  /**
   * The admin-entered runtime reason is MANDATORY and AUTHORITATIVE for this
   * template — see `renderEmailTemplateOverride`'s reason guard. CMS body text
   * can say anything around it, but the actual reason line is always the live
   * `{{reason}}` value, never CMS-authored text, and is always shown even if
   * the admin's custom body omits the token.
   */
  requiresReason: boolean;
  /** Who receives this — drives the footer's "why you received this" line. */
  audience: "seller" | "customer" | "ops";
};

const t = (
  key: string,
  label: string,
  category: EmailTemplateCategory,
  description: string,
  allowedTokens: EmailToken[],
  opts: { actionButton?: boolean; extraMessage?: boolean; requiresReason?: boolean; audience?: "seller" | "customer" | "ops" } = {},
): EmailTemplateDef => ({
  key,
  label,
  category,
  description,
  allowedTokens: ["storeName", ...allowedTokens],
  hasActionButton: opts.actionButton ?? true,
  hasExtraMessage: opts.extraMessage ?? true,
  requiresReason: opts.requiresReason ?? false,
  audience: opts.audience ?? (category === "payment" ? "customer" : "seller"),
});

export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
  // ── Seller lifecycle ──────────────────────────────────────────────────
  t("seller_account_submitted", "Seller application submitted", "seller_lifecycle",
    "Sent the moment a new seller application is received (PENDING).",
    ["sellerName"], { actionButton: false }),
  t("seller_account_approved", "Seller application approved", "seller_lifecycle",
    "Sent when an application (or a reactivated account) is approved.",
    ["sellerName", "actionUrl"]),
  t("seller_account_rejected", "Seller application rejected", "seller_lifecycle",
    "Sent when an application is rejected. The admin's reason is always shown verbatim.",
    ["sellerName", "reason"], { actionButton: false, requiresReason: true }),
  t("seller_account_reopened", "Seller application reopened", "seller_lifecycle",
    "Sent when a rejected application is reopened for another look. The admin's note is always shown verbatim.",
    ["sellerName", "reason"], { actionButton: false, requiresReason: true }),

  // ── Product lifecycle ─────────────────────────────────────────────────
  t("seller_product_request_submitted", "Product submission received", "product_lifecycle",
    "Sent to the seller when a product request is submitted for review (first time or resubmission).",
    ["sellerName", "productName", "actionUrl"]),
  t("seller_product_request_approved", "Product approved", "product_lifecycle",
    "Sent when a product request is approved.",
    ["sellerName", "productName", "actionUrl"]),
  t("seller_product_request_rejected", "Product rejected", "product_lifecycle",
    "Sent when a product request is rejected outright. The admin's reason is always shown verbatim.",
    ["sellerName", "productName", "reason"], { actionButton: false, requiresReason: true }),
  t("seller_product_request_changes_requested", "Product changes requested", "product_lifecycle",
    "Sent when a product request is sent back for changes (resubmittable). The admin's note is always shown verbatim.",
    ["sellerName", "productName", "reason", "actionUrl"], { requiresReason: true }),
  t("seller_product_request_resubmitted_ops", "Product resubmitted (Ops notice)", "product_lifecycle",
    "Internal Ops notice when a previously-reviewed product request is resubmitted.",
    ["sellerName", "productName", "actionUrl"], { audience: "ops" }),

  // ── Order / fulfilment ────────────────────────────────────────────────
  t("seller_order_received", "Seller order received", "order_fulfilment",
    "Sent to the seller when a new 3P order is placed.",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_order_accepted", "Seller order accepted", "order_fulfilment",
    "Self-confirmation receipt when the seller accepts an order.",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_order_acceptance_reminder", "Seller acceptance reminder", "order_fulfilment",
    "Sent when an order has waited past the acceptance SLA reminder threshold.",
    ["sellerName", "orderNumber", "status", "actionUrl"]),
  t("seller_order_acceptance_overdue_ops", "Seller acceptance escalation (Ops notice)", "order_fulfilment",
    "Internal Ops notice when an order is overdue past the acceptance SLA escalation threshold.",
    ["sellerName", "orderNumber", "status", "actionUrl"], { audience: "ops" }),
  t("seller_order_ready_to_ship", "Seller order ready to ship", "order_fulfilment",
    "Self-confirmation receipt when the seller marks an order ready to ship.",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_shipment_created", "Shipment created", "order_fulfilment",
    "Sent when a shipment record (carrier + tracking) is created for an order.",
    ["sellerName", "orderNumber", "carrier", "trackingNumber", "actionUrl"]),
  t("seller_order_shipped", "Seller order shipped", "order_fulfilment",
    "Self-confirmation receipt when the seller's order reaches Shipped.",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_order_delivered", "Seller order delivered", "order_fulfilment",
    "Self-confirmation receipt when the seller's order reaches Delivered.",
    ["sellerName", "orderNumber", "actionUrl"]),

  // ── Post-order ────────────────────────────────────────────────────────
  t("seller_order_cancelled", "Customer cancellation affecting seller", "post_order",
    "Sent to the seller when an order covering their line is cancelled.",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_return_requested", "Return requested", "post_order",
    "Sent to the seller when a customer opens a return covering their line.",
    ["sellerName", "orderNumber", "status", "actionUrl"]),
  t("seller_return_received", "Return received", "post_order",
    "Sent to the seller when a return covering their line is received back (admin-triggered).",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_return_approved", "Return approved", "post_order",
    "Sent to the seller when a return covering their line is approved.",
    ["sellerName", "orderNumber", "actionUrl"]),
  t("seller_return_rejected", "Return rejected", "post_order",
    "Sent to the seller when a return covering their line is rejected. The admin's reason is always shown verbatim.",
    ["sellerName", "orderNumber", "reason", "actionUrl"], { requiresReason: true }),
  t("seller_refund_notice", "Refund affecting seller", "post_order",
    "Sent to the seller when a bookkeeping refund completes on an order covering their line.",
    ["sellerName", "orderNumber", "refundAmount", "actionUrl"]),
  t("seller_settlement_recorded", "Seller settlement", "post_order",
    "Sent to the seller when a settlement is recorded.",
    ["sellerName", "settlementAmount", "actionUrl"]),

  // ── PayMongo (customer-facing) ────────────────────────────────────────
  t("payment_confirmation", "Payment received", "payment",
    "Sent to the customer when an online payment is confirmed by the PayMongo webhook.",
    ["orderNumber", "status", "actionUrl"], { extraMessage: false }),
  t("payment_failed", "Payment failed", "payment",
    "Sent to the customer when PayMongo reports a failed payment attempt.",
    ["orderNumber", "actionUrl"]),
  t("payment_expired_or_cancelled", "Payment expired / cancelled", "payment",
    "Sent to the customer when a PayMongo checkout session expires or is abandoned.",
    ["orderNumber", "actionUrl"]),
  t("refund_completed", "Refund completed", "payment",
    "Sent to the customer when a refund is confirmed by PayMongo.",
    ["orderNumber", "refundAmount", "status", "actionUrl"], { extraMessage: false }),
];

export const EMAIL_TEMPLATE_KEYS = EMAIL_TEMPLATES.map((d) => d.key);

const BY_KEY = new Map(EMAIL_TEMPLATES.map((d) => [d.key, d]));

export function isEmailTemplateKey(v: string): boolean {
  return BY_KEY.has(v);
}

export function getEmailTemplateDef(key: string): EmailTemplateDef | undefined {
  return BY_KEY.get(key);
}

/** Stable ContentBlock key for a template, e.g. "email.seller_account_rejected". */
export function emailTemplateBlockKey(templateKey: string): string {
  return `email.${templateKey}`;
}
