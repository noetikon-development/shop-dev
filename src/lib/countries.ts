/**
 * The set of countries AXIARO ships to. Pure data — safe to import anywhere.
 *
 * Today this is the Philippines only. The address system stores an
 * ISO-3166-1 alpha-2 `code` and validates it against this list, so adding a
 * country later is a one-line change here with no schema or code restructuring.
 * `regionLabel` / `subregionLabel` let the address form use locally correct
 * wording (Region / Province vs. State / County …).
 */

export type Country = {
  code: string; // ISO-3166-1 alpha-2
  name: string;
  /** Label for the primary administrative division (schema field `province`). */
  regionLabel: string;
  /** Label for the secondary division shown for this country, if any (schema field `region`). */
  subregionLabel?: string;
  /** Whether the barangay field is relevant for this country. */
  usesBarangay: boolean;
  /** Rough postal-code shape check. */
  postalPattern: RegExp;
  phonePattern: RegExp;
};

export const COUNTRIES: readonly Country[] = [
  {
    code: "PH",
    name: "Philippines",
    regionLabel: "Province",
    subregionLabel: "Region",
    usesBarangay: true,
    postalPattern: /^\d{4}$/,
    phonePattern: /^(\+?63|0)\s?\d[\d\s-]{7,13}$/,
  },
] as const;

export const COUNTRY_CODES = COUNTRIES.map((c) => c.code) as [string, ...string[]];

export const DEFAULT_COUNTRY = "PH";

export function getCountry(code: string): Country | undefined {
  return COUNTRIES.find((c) => c.code === code);
}

export function isSupportedCountry(code: string): boolean {
  return COUNTRIES.some((c) => c.code === code);
}

export function countryName(code: string): string {
  return getCountry(code)?.name ?? code;
}
