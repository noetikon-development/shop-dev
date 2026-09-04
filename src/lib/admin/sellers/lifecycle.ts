/**
 * Seller lifecycle — the pure state machine (Phase 9F-4b).
 *
 * Plain data, safe to import anywhere. The exact transition set is fixed by the
 * 9F-4b spec — no statuses are invented here:
 *
 *   PENDING   → APPROVED
 *   APPROVED  → SUSPENDED | CLOSED
 *   SUSPENDED → APPROVED  | CLOSED
 *   CLOSED    → (terminal)
 *
 * `PENDING → CLOSED` (reject an application) is deliberately NOT included — it is
 * out of the 9F-4b scope and would be an additive change later.
 */

export const SELLER_STATUSES = ["PENDING", "APPROVED", "SUSPENDED", "CLOSED"] as const;
export type SellerLifecycleStatus = (typeof SELLER_STATUSES)[number];

export const SELLER_TRANSITIONS: Record<SellerLifecycleStatus, SellerLifecycleStatus[]> = {
  PENDING: ["APPROVED"],
  APPROVED: ["SUSPENDED", "CLOSED"],
  SUSPENDED: ["APPROVED", "CLOSED"],
  CLOSED: [],
};

export function canTransitionSeller(from: string, to: string): boolean {
  const allowed = SELLER_TRANSITIONS[from as SellerLifecycleStatus];
  return Array.isArray(allowed) && allowed.includes(to as SellerLifecycleStatus);
}

/** The audit action string for a given transition (used by the admin actions). */
export function sellerTransitionAction(to: SellerLifecycleStatus): string {
  switch (to) {
    case "APPROVED":
      return "seller.approved"; // covers PENDING→APPROVED and SUSPENDED→APPROVED (reactivate)
    case "SUSPENDED":
      return "seller.suspended";
    case "CLOSED":
      return "seller.closed";
    default:
      return "seller.updated";
  }
}

export function sellerStatusLabel(status: string): string {
  switch (status) {
    case "PENDING":
      return "Pending";
    case "APPROVED":
      return "Approved";
    case "SUSPENDED":
      return "Suspended";
    case "CLOSED":
      return "Closed";
    default:
      return status;
  }
}

export function sellerStatusTone(status: string): "neutral" | "success" | "warning" | "danger" | "info" {
  switch (status) {
    case "APPROVED":
      return "success";
    case "PENDING":
      return "info";
    case "SUSPENDED":
      return "warning";
    case "CLOSED":
      return "danger";
    default:
      return "neutral";
  }
}

// ---------------------------------------------------------------------------
// Slug — admin owns the canonical Seller.slug (safe for a future /store/<slug>)
// ---------------------------------------------------------------------------

export const SELLER_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Path segments a seller slug must never collide with. */
export const RESERVED_SELLER_SLUGS = new Set([
  "admin",
  "api",
  "auth",
  "seller",
  "store",
  "account",
  "cart",
  "checkout",
  "login",
  "logout",
  "register",
  "search",
  "p",
  "c",
  "pages",
  "order",
  "orders",
  "track",
  "wishlist",
  "promotions",
  "new",
  "all",
  "sale",
  "returns",
  "sitemap",
  "robots",
]);

export type SlugCheck = { ok: true; slug: string } | { ok: false; error: string };

export function validateSellerSlug(raw: unknown): SlugCheck {
  const slug = String(raw ?? "").trim().toLowerCase();
  if (slug.length < 3 || slug.length > 40) {
    return { ok: false, error: "Slug must be 3–40 characters." };
  }
  if (!SELLER_SLUG_RE.test(slug)) {
    return { ok: false, error: "Lowercase letters, numbers and single dashes only." };
  }
  if (RESERVED_SELLER_SLUGS.has(slug)) {
    return { ok: false, error: "That slug is reserved." };
  }
  return { ok: true, slug };
}

// ---------------------------------------------------------------------------
// Commission — stored as integer basis points, 0..10000 (0%..100%)
// ---------------------------------------------------------------------------

/** Default marketplace commission for a newly created third-party seller (15.00%). */
export const DEFAULT_SELLER_COMMISSION_BPS = 1500;

export function validateCommissionBps(raw: unknown): { ok: true; bps: number } | { ok: false; error: string } {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  if (!Number.isInteger(n) || n < 0 || n > 10000) {
    return { ok: false, error: "Commission must be a whole number of basis points, 0–10000." };
  }
  return { ok: true, bps: n };
}
