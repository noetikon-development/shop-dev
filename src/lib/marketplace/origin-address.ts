import "server-only";
import type { Prisma } from "@prisma/client";
import { cleanUserText } from "@/lib/ugc";
import { getCountry, isSupportedCountry } from "@/lib/countries";
import type { SellerOriginAddress } from "@/lib/marketplace/types";

export type { SellerOriginAddress };

/**
 * Seller forward-shipment pickup/origin address — structure + validation
 * (mirrors `returnAddress` in `return-destination.ts` exactly; a separate
 * module because this address has nothing to do with return routing).
 *
 * `Seller.originAddress` is a structured JSON blob, part of the SAME moderated
 * profile bundle as `returnAddress` (DRAFT → PENDING → APPROVED via
 * `writeBundle` in `seller-profile-repository.ts`). It is DATA ONLY today —
 * nothing reads it to book a shipment, quote a rate, or address a label.
 */

/** Fields a seller fills on the pickup-address form (`originAddress.<field>`). */
export const SELLER_ORIGIN_ADDRESS_FIELDS = [
  "recipient",
  "line1",
  "line2",
  "barangay",
  "city",
  "province",
  "postalCode",
  "country",
  "phone",
  "lat",
  "lng",
] as const;

const REQUIRED_ADDRESS_FIELDS = ["recipient", "line1", "city", "province", "postalCode", "country", "phone"] as const;

/** A plain decimal number, optionally signed — never scientific notation. */
function isNumericString(raw: string): boolean {
  return /^-?\d+(\.\d+)?$/.test(raw);
}

export type SellerOriginAddressValidation =
  | { ok: true; value: SellerOriginAddress | null }
  | { ok: false; error: string };

/**
 * Validate a raw `{ field: string }` map from the settings form.
 *   - every field blank  → `{ ok: true, value: null }` (address cleared)
 *   - any field present  → all required fields must be valid; phone + postal
 *     code checked against the country's pattern (same rule as the customer
 *     address book / the seller return address).
 */
export function validateSellerOriginAddress(raw: Record<string, unknown>): SellerOriginAddressValidation {
  const field = (k: string) => cleanUserText(raw[k]).trim();
  const parts = {
    recipient: field("recipient"),
    line1: field("line1"),
    line2: field("line2"),
    barangay: field("barangay"),
    city: field("city"),
    province: field("province"),
    postalCode: field("postalCode"),
    country: field("country").toUpperCase(),
    phone: field("phone"),
    lat: field("lat"),
    lng: field("lng"),
  };

  const anyFilled = SELLER_ORIGIN_ADDRESS_FIELDS.some((k) => parts[k] !== "");
  if (!anyFilled) return { ok: true, value: null };

  for (const k of REQUIRED_ADDRESS_FIELDS) {
    if (parts[k] === "") return { ok: false, error: `Pickup address — ${labelFor(k)} is required.` };
  }
  if (parts.recipient.length > 120) return { ok: false, error: "Pickup address — recipient is too long." };
  if (parts.line1.length > 160 || parts.line2.length > 160) return { ok: false, error: "Pickup address — a street line is too long." };
  if (parts.barangay.length > 80 || parts.city.length > 80 || parts.province.length > 80) {
    return { ok: false, error: "Pickup address — a locality field is too long." };
  }
  if (!isSupportedCountry(parts.country)) return { ok: false, error: "Pickup address — that country isn't on the supported list." };
  const country = getCountry(parts.country);
  if (country && !country.postalPattern.test(parts.postalCode)) {
    return { ok: false, error: `Pickup address — that postal code doesn't look right for ${country.name}.` };
  }
  if (country && !country.phonePattern.test(parts.phone)) {
    return { ok: false, error: "Pickup address — that phone number doesn't look right." };
  }
  if (parts.phone.length > 30) return { ok: false, error: "Pickup address — the phone number is too long." };

  // Coordinates are optional and never geocoded — a seller pastes them in
  // manually (e.g. from a map link) for a future real-carrier pickup booking.
  if (parts.lat !== "" && (!isNumericString(parts.lat) || Number(parts.lat) < -90 || Number(parts.lat) > 90)) {
    return { ok: false, error: "Pickup address — latitude must be a number between -90 and 90." };
  }
  if (parts.lng !== "" && (!isNumericString(parts.lng) || Number(parts.lng) < -180 || Number(parts.lng) > 180)) {
    return { ok: false, error: "Pickup address — longitude must be a number between -180 and 180." };
  }

  return {
    ok: true,
    value: {
      recipient: parts.recipient,
      line1: parts.line1,
      line2: parts.line2 || null,
      barangay: parts.barangay || null,
      city: parts.city,
      province: parts.province,
      postalCode: parts.postalCode,
      country: parts.country,
      phone: parts.phone,
      lat: parts.lat || null,
      lng: parts.lng || null,
    },
  };
}

function labelFor(k: string): string {
  return (
    {
      recipient: "recipient name",
      line1: "street address",
      city: "city / municipality",
      province: "province / region",
      postalCode: "postal code",
      country: "country",
      phone: "phone",
    } as Record<string, string>
  )[k] ?? k;
}

/** Read a stored `Seller.originAddress` JSON blob back into the typed shape (or null when incomplete). */
export function parseSellerOriginAddress(raw: Prisma.JsonValue | null | undefined): SellerOriginAddress | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  for (const k of REQUIRED_ADDRESS_FIELDS) {
    if (s(k).trim() === "") return null;
  }
  return {
    recipient: s("recipient"),
    line1: s("line1"),
    line2: s("line2") || null,
    barangay: s("barangay") || null,
    city: s("city"),
    province: s("province"),
    postalCode: s("postalCode"),
    country: s("country"),
    phone: s("phone"),
    lat: s("lat") || null,
    lng: s("lng") || null,
  };
}

/** Address → display lines (admin review). */
export function sellerOriginAddressLines(a: SellerOriginAddress): string[] {
  return [
    a.recipient,
    a.line1,
    a.line2,
    [a.barangay, a.city].filter(Boolean).join(", "),
    [a.province, a.postalCode].filter(Boolean).join(" "),
    getCountry(a.country)?.name ?? a.country,
    a.phone,
  ].filter((x): x is string => Boolean(x && x.trim()));
}
