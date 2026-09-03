/**
 * Marketplace foundation types (Phase 9C).
 *
 * Plain types — safe to import from server or client code. None of this is
 * wired into the storefront, cart, checkout or admin in Phase 9C.
 */

export type SellerType = "FIRST_PARTY" | "THIRD_PARTY";
export type SellerStatus = "PENDING" | "APPROVED" | "SUSPENDED" | "CLOSED";
export type SellerUserRole = "OWNER" | "MANAGER" | "STAFF";
export type SellerUserStatus = "ACTIVE" | "INVITED" | "DISABLED";

export type OfferCondition = "NEW" | "REFURBISHED" | "USED_LIKE_NEW" | "USED_GOOD";
export type OfferStatus = "DRAFT" | "ACTIVE" | "INACTIVE" | "ARCHIVED";
export type FulfillmentType = "SELLER_FULFILLED" | "PLATFORM_FULFILLED";

/**
 * A candidate row fed to the pure buy-box rule (`pickWinningOffer`). Deliberately
 * flat and framework-free so the selection logic can be unit-tested with
 * fixtures and no database.
 */
export type OfferCandidate = {
  offerId: string;
  sellerId: string;
  sellerType: SellerType;
  sellerStatus: SellerStatus;
  offerStatus: OfferStatus;
  /** OfferInventory.quantity - OfferInventory.reserved */
  available: number;
  /** Offer.price, centavos */
  price: number;
  createdAt: Date;
};

/**
 * A candidate enriched with the winner's compare-at price — the shape the
 * catalog-card price computation needs (it must report the compare-at of the
 * offer that produced the minimum displayed price).
 */
export type CardOffer = OfferCandidate & { compareAtPrice: number | null };

/**
 * A candidate enriched with its OfferInventory reorder point — the shape the
 * variant-availability computation needs (Phase 9D-D).
 */
export type StockOfferCandidate = OfferCandidate & { reorderPoint: number };

/**
 * Product-card pricing derived from the winning offers across a product's ACTIVE
 * variants (Phase 9D-A). `minPrice` is `null` only when NO variant has a
 * display-eligible offer — the card then shows no price and the existing
 * out-of-stock / unavailable presentation stands.
 */
export type CatalogCardPricing = {
  /** lowest winning-offer price across the product's ACTIVE variants (centavos) */
  minPrice: number | null;
  /** compare-at of the offer that produced `minPrice`, only when it exceeds it */
  minCompareAtPrice: number | null;
  /** true when eligible variants resolve to more than one distinct winning price → render "From ₱X" */
  isFrom: boolean;
  /** true when any display-eligible offer on the product carries a compare-at (loose, matches today's on-sale predicate) */
  onSale: boolean;
  /** number of variants that contributed a winning offer */
  eligibleVariantCount: number;
};

/** The public-facing result of buy-box resolution. Contains no cost / private data. */
export type ResolvedOffer = {
  offerId: string;
  sellerId: string;
  sellerType: SellerType;
  sellerDisplayName: string;
  variantId: string;
  price: number;
  compareAtPrice: number | null;
  available: number;
  condition: OfferCondition;
  fulfillmentType: FulfillmentType;
  handlingTimeDays: number;
};

export type CatalogPriceRange = {
  min: number | null;
  max: number | null;
  /** number of buy-box-eligible offers across all of the product's variants */
  offerCount: number;
};

export type VariantAvailability = {
  /** sum of `available` across all buy-box-eligible offers on the variant */
  available: number;
  offerCount: number;
};

/**
 * Reserved for future buy-box signals (currency, region, membership, …).
 * Unused in Phase 9C — the resolver ignores it beyond passing it through.
 */
export type OfferResolutionContext = Record<string, never>;

/**
 * Seller-scoped request context. Established once, server-side, at the top of
 * every future /seller request / server action (there are none in Phase 9C).
 * Mirrors the shape of `AdminContext` in src/lib/admin/rbac.ts.
 */
export type SellerContext = {
  sellerId: string;
  sellerUserId: string;
  role: SellerUserRole;
  /** union of seller-scoped permission keys granted by `role` */
  permissions: Set<string>;
};
