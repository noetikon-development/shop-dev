import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cleanUserText } from "@/lib/ugc";
import { getCountry, isSupportedCountry } from "@/lib/countries";
import { getReturnsConfig } from "@/lib/returns";
import type { SellerReturnAddress } from "@/lib/marketplace/types";

export type { SellerReturnAddress };

/**
 * 3P return routing — the seller return address + the frozen return-destination
 * snapshot (Phase 9F-41B).
 *
 * `Seller.returnAddress` is a structured JSON blob, part of the moderated
 * profile bundle. At `approveReturnAction` the destination is RESOLVED once and
 * FROZEN onto `ReturnRequest.returnDestination` — a later address / instructions
 * edit never changes an already-approved return.
 *
 * Nothing here changes the return state machine, the refund calc, the
 * commission correction, settlement blocking / clawback, or inventory restock.
 */

type Client = Prisma.TransactionClient | typeof prisma;

// ---------------------------------------------------------------------------
// Seller return address — structure + validation
// ---------------------------------------------------------------------------

/** Fields a seller fills on the return-address form (`returnAddress.<field>`). */
export const SELLER_RETURN_ADDRESS_FIELDS = [
  "recipient",
  "line1",
  "line2",
  "barangay",
  "city",
  "province",
  "postalCode",
  "country",
  "phone",
] as const;

const REQUIRED_ADDRESS_FIELDS = ["recipient", "line1", "city", "province", "postalCode", "country", "phone"] as const;

export type SellerReturnAddressValidation =
  | { ok: true; value: SellerReturnAddress | null }
  | { ok: false; error: string };

/**
 * Validate a raw `{ field: string }` map from the settings form.
 *   - every field blank  → `{ ok: true, value: null }` (address cleared)
 *   - any field present  → all required fields must be valid; phone + postal
 *     code checked against the country's pattern (same rule as the customer
 *     address book, `addressInputSchema`).
 */
export function validateSellerReturnAddress(raw: Record<string, unknown>): SellerReturnAddressValidation {
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
  };

  const anyFilled = SELLER_RETURN_ADDRESS_FIELDS.some((k) => parts[k] !== "");
  if (!anyFilled) return { ok: true, value: null };

  for (const k of REQUIRED_ADDRESS_FIELDS) {
    if (parts[k] === "") return { ok: false, error: `Return address — ${labelFor(k)} is required.` };
  }
  if (parts.recipient.length > 120) return { ok: false, error: "Return address — recipient is too long." };
  if (parts.line1.length > 160 || parts.line2.length > 160) return { ok: false, error: "Return address — a street line is too long." };
  if (parts.barangay.length > 80 || parts.city.length > 80 || parts.province.length > 80) {
    return { ok: false, error: "Return address — a locality field is too long." };
  }
  if (!isSupportedCountry(parts.country)) return { ok: false, error: "Return address — that country isn't on the supported list." };
  const country = getCountry(parts.country);
  if (country && !country.postalPattern.test(parts.postalCode)) {
    return { ok: false, error: `Return address — that postal code doesn't look right for ${country.name}.` };
  }
  if (country && !country.phonePattern.test(parts.phone)) {
    return { ok: false, error: "Return address — that phone number doesn't look right." };
  }
  if (parts.phone.length > 30) return { ok: false, error: "Return address — the phone number is too long." };

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

/** Read a stored `Seller.returnAddress` JSON blob back into the typed shape (or null when incomplete). */
export function parseSellerReturnAddress(raw: Prisma.JsonValue | null | undefined): SellerReturnAddress | null {
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
  };
}

/** Address → display lines (customer email + all three return surfaces). */
export function sellerReturnAddressLines(a: SellerReturnAddress): string[] {
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

// ---------------------------------------------------------------------------
// The frozen return-destination snapshot
// ---------------------------------------------------------------------------

export type ReturnDestination = {
  /** "seller" — a single 3P seller's own return address; "store" — the store-wide instructions. */
  kind: "seller" | "store";
  /** true when Axiaro must coordinate manually (mixed / multi-3P / 3P without an approved address). */
  manualHandling: boolean;
  /** every affected THIRD_PARTY seller id (for the seller-approved email loop + admin display). */
  sellerIds: string[];
  // kind === "seller"
  sellerId?: string;
  sellerName?: string;
  returnPolicy?: string | null;
  address?: SellerReturnAddress;
  // kind === "store"
  instructions?: string | null;
  policyUrl?: string | null;
};

/** Every distinct seller snapshotted on this return's lines (mirrors `getReturnAffectedSellerIds`). */
async function affectedSellerIds(returnId: string, client: Client): Promise<string[]> {
  const rows = await client.returnItem.findMany({
    where: { returnRequestId: returnId },
    select: { orderItem: { select: { sellerId: true } } },
  });
  return [...new Set(rows.map((r) => r.orderItem.sellerId).filter((v): v is string => Boolean(v)))];
}

/**
 * Resolve where a return's goods should go. Called ONCE at approval; the result
 * is frozen onto `ReturnRequest.returnDestination`.
 *
 *   1 THIRD_PARTY seller + its bundle APPROVED + a complete returnAddress
 *       → { kind: "seller", manualHandling: false }
 *   0 THIRD_PARTY sellers (1P-only)
 *       → { kind: "store",  manualHandling: false }
 *   mixed / >1 THIRD_PARTY seller / 3P without an approved address
 *       → { kind: "store",  manualHandling: true }  (safe store-wide fallback)
 */
export async function resolveReturnDestination(
  returnId: string,
  client: Client = prisma,
): Promise<ReturnDestination> {
  const cfg = await getReturnsConfig();
  const storeFallback = (manualHandling: boolean, sellerIds: string[]): ReturnDestination => ({
    kind: "store",
    manualHandling,
    sellerIds,
    instructions: cfg.instructions || null,
    policyUrl: cfg.policyUrl || null,
  });

  const ids = await affectedSellerIds(returnId, client);
  if (ids.length === 0) return storeFallback(false, []);

  const sellers = await client.seller.findMany({
    where: { id: { in: ids } },
    select: { id: true, type: true, displayName: true, contentStatus: true, returnPolicy: true, returnAddress: true },
  });
  const thirdParty = sellers.filter((s) => s.type === "THIRD_PARTY");

  if (thirdParty.length === 0) return storeFallback(false, []); // 1P-only

  const thirdPartyIds = thirdParty.map((s) => s.id);

  if (thirdParty.length === 1) {
    const s = thirdParty[0];
    const address = s.contentStatus === "APPROVED" ? parseSellerReturnAddress(s.returnAddress) : null;
    if (address) {
      return {
        kind: "seller",
        manualHandling: false,
        sellerIds: thirdPartyIds,
        sellerId: s.id,
        sellerName: s.displayName,
        returnPolicy: s.returnPolicy ?? null,
        address,
      };
    }
    // single 3P seller, no usable address → store-wide fallback + manual flag
    return storeFallback(true, thirdPartyIds);
  }

  // mixed 1P+3P is caught above (thirdParty.length is 1..n; a mix still has
  // thirdParty.length >= 1). Multiple 3P sellers → manual.
  return storeFallback(true, thirdPartyIds);
}

/** Read a frozen `ReturnRequest.returnDestination` JSON blob back into the typed shape. */
export function parseReturnDestination(raw: Prisma.JsonValue | null | undefined): ReturnDestination | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.kind !== "seller" && o.kind !== "store") return null;
  const kind: "seller" | "store" = o.kind;
  const sellerIds = Array.isArray(o.sellerIds) ? o.sellerIds.filter((x): x is string => typeof x === "string") : [];
  const base = { kind, manualHandling: Boolean(o.manualHandling), sellerIds };
  if (kind === "seller") {
    const address = parseSellerReturnAddress(o.address as Prisma.JsonValue);
    if (!address) return { ...base, kind: "store", instructions: null, policyUrl: null };
    return {
      ...base,
      sellerId: typeof o.sellerId === "string" ? o.sellerId : undefined,
      sellerName: typeof o.sellerName === "string" ? o.sellerName : undefined,
      returnPolicy: typeof o.returnPolicy === "string" ? o.returnPolicy : null,
      address,
    };
  }
  return {
    ...base,
    instructions: typeof o.instructions === "string" ? o.instructions : null,
    policyUrl: typeof o.policyUrl === "string" ? o.policyUrl : null,
  };
}

/**
 * The customer/seller/admin "where to send it" display block for a resolved
 * destination. `fallbackInstructions` is the live `returns.instructions` used
 * ONLY when the snapshot is a store-kind one with no frozen instructions, or
 * when there is no snapshot at all (legacy) — preserving pre-9F-41B behaviour.
 */
export function returnDestinationDisplay(
  dest: ReturnDestination | null,
  fallbackInstructions: string | null,
): { heading: string; lines: string[]; note: string | null; policyUrl: string | null } {
  if (dest?.kind === "seller" && dest.address) {
    return {
      heading: `Send your return to ${dest.sellerName ?? "the seller"}`,
      lines: sellerReturnAddressLines(dest.address),
      note: dest.returnPolicy?.trim() || null,
      policyUrl: null,
    };
  }
  const instructions =
    (dest?.kind === "store" ? dest.instructions : null) || fallbackInstructions || null;
  return {
    heading: "How to send your return",
    lines: instructions ? instructions.split("\n").map((l) => l.trim()).filter(Boolean) : [],
    note: dest?.manualHandling
      ? "Our team will confirm the exact return address by email shortly."
      : instructions
        ? null
        : "We'll be in touch shortly with where to send the items.",
    policyUrl: dest?.kind === "store" ? dest.policyUrl ?? null : null,
  };
}
