/**
 * Courier / carrier catalogue (Step 13). Pure config + pure helpers — safe to
 * import from server, client and edge code.
 *
 * This is intentionally plain data, not a database model: the store does not
 * manage couriers through a CRUD screen yet, and the spec asks for a simple,
 * extensible design. A future courier-API integration attaches by matching on
 * `code` — the `Order.courier` column stores that code, so the API layer can be
 * added without any schema change.
 *
 * `trackingUrlTemplate` is a best-effort public tracking-page pattern. It is only
 * used to auto-fill a tracking URL when the admin gives a tracking number and no
 * explicit URL; the admin can always paste an exact URL instead. `{tracking}` is
 * replaced with the URL-encoded tracking number.
 */

export type CourierDef = {
  code: string;
  name: string;
  /** null = the admin must enter a tracking URL by hand (or leave it blank). */
  trackingUrlTemplate: string | null;
  /** Whether a tracking number is expected when shipping with this courier. */
  requiresTracking: boolean;
};

export const COURIERS: CourierDef[] = [
  {
    code: "JT_EXPRESS",
    name: "J&T Express",
    trackingUrlTemplate: "https://www.jtexpress.ph/index/query/gzquery.html?bills={tracking}",
    requiresTracking: true,
  },
  {
    code: "LBC",
    name: "LBC Express",
    trackingUrlTemplate: "https://www.lbcexpress.com/track/?tracking_no={tracking}",
    requiresTracking: true,
  },
  {
    code: "NINJAVAN",
    name: "Ninja Van",
    trackingUrlTemplate: "https://www.ninjavan.co/en-ph/tracking?id={tracking}",
    requiresTracking: true,
  },
  {
    code: "FLASH",
    name: "Flash Express",
    trackingUrlTemplate: "https://www.flashexpress.ph/tracking/?se={tracking}",
    requiresTracking: true,
  },
  {
    // Same-day / on-demand — tracking is a share link, not a number, so no template.
    code: "LALAMOVE",
    name: "Lalamove",
    trackingUrlTemplate: null,
    requiresTracking: false,
  },
  {
    code: "PICKUP",
    name: "Store Pickup",
    trackingUrlTemplate: null,
    requiresTracking: false,
  },
  {
    code: "OTHER",
    name: "Other / manual courier",
    trackingUrlTemplate: null,
    requiresTracking: false,
  },
];

export const COURIER_CODES = COURIERS.map((c) => c.code);

const BY_CODE = new Map(COURIERS.map((c) => [c.code, c]));

export function isCourierCode(value: string): boolean {
  return BY_CODE.has(value);
}

export function getCourier(code: string | null | undefined): CourierDef | undefined {
  return code ? BY_CODE.get(code) : undefined;
}

/**
 * Display name for a courier. A stored `nameSnapshot` wins (it carries the custom
 * text for "OTHER", and keeps history stable if a catalogue name later changes).
 */
export function courierLabel(
  code: string | null | undefined,
  nameSnapshot?: string | null,
): string {
  if (nameSnapshot && nameSnapshot.trim()) return nameSnapshot.trim();
  return getCourier(code)?.name ?? code ?? "—";
}

/** true when the shipping-method snapshot says this order is collected in store. */
export function isStorePickupCode(shippingMethodCode: string | null | undefined): boolean {
  return shippingMethodCode === "PICKUP";
}

const UNSAFE_URL_PROTOCOLS = ["javascript:", "data:", "vbscript:", "file:", "blob:"];

/**
 * A tracking URL is safe to store/render only if it parses and is plain HTTPS.
 * Everything else (http, javascript:, data:, relative, garbage) is rejected.
 */
export function isSafeTrackingUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value || value.length > 500) return false;
  const lower = value.toLowerCase();
  if (UNSAFE_URL_PROTOCOLS.some((p) => lower.startsWith(p))) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:";
}

/**
 * Build a tracking URL from the courier's template, or null when the courier has
 * no template or there is no tracking number. The result still passes
 * `isSafeTrackingUrl` (all templates are HTTPS).
 */
export function buildTrackingUrl(
  code: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  const courier = getCourier(code);
  const tn = (trackingNumber ?? "").trim();
  if (!courier?.trackingUrlTemplate || !tn) return null;
  const built = courier.trackingUrlTemplate.replace("{tracking}", encodeURIComponent(tn));
  return isSafeTrackingUrl(built) ? built : null;
}
