import type { ArtKind } from "@/lib/product-art";
import type { StockStatus } from "@/lib/inventory-status";

export type ImageRef = { url: string; alt: string };

/**
 * A product-detail gallery image. `optionValueId` is the explicit link to a
 * Colour option value (ProductOptionValue.id); null means the image applies to
 * every colour. The PDP gallery is driven entirely by this field.
 */
export type GalleryImage = ImageRef & { optionValueId: string | null };

export type OptionValueView = {
  id: string;
  value: string;
  swatchHex: string | null;
};

export type OptionView = {
  id: string;
  name: string;
  values: OptionValueView[];
};

export type VariantView = {
  id: string;
  sku: string;
  /**
   * `Variant.price` / `Variant.compareAtPrice` — retained as compatibility /
   * legacy fields (still kept current by the 9D-A admin write-through). Phase
   * 9D-B: the PDP no longer renders these; it reads `offerPrice` /
   * `offerCompareAtPrice` below.
   */
  price: number;
  compareAtPrice: number | null;
  /**
   * The winning Axiaro FIRST_PARTY `Offer` price for this variant, resolved
   * server-side with the FULL stock-aware buy-box rule (Phase 9D-B). `null` =
   * no eligible offer (seller suspended / offer inactive / out of stock / none)
   * → the PDP shows "Currently unavailable" and never falls back to `price`.
   */
  offerPrice: number | null;
  offerCompareAtPrice: number | null;
  stock: number; // available (quantity - reserved) — UNCHANGED, still Variant.stock
  reorderPoint: number;
  status: string; // ACTIVE | ARCHIVED
  imageUrl: string | null;
  optionValueIds: string[];
};

export type ProductCardView = {
  id: string;
  slug: string;
  name: string;
  brand: string;
  shortDescription: string;
  /**
   * The product-card selling price. Phase 9D-A: the minimum winning Axiaro
   * FIRST_PARTY `Offer.price` across the product's ACTIVE variants (was
   * `Product.price`). Kept non-null — a card whose price cannot be resolved is a
   * write-through gap and fails the parity gate.
   */
  price: number;
  compareAtPrice: number | null;
  /** true → render "From ₱X" (eligible variants resolve to more than one winning price) */
  priceFrom: boolean;
  ratingAvg: number;
  ratingCount: number;
  soldCount: number;
  badges: string[];
  freeShipping: boolean;
  image: ImageRef;
  art: ArtKind;
  categorySlug: string;
  categoryName: string;
  colorSwatches: string[];
  inStock: boolean;
  stockStatus: StockStatus;
  /** The single ACTIVE variant's id when a product has exactly one; null when a
   *  choice is required (quick-add is then disabled and the card links to PDP). */
  defaultVariantId: string | null;
  createdAt: string;
};

export type ProductDetailView = ProductCardView & {
  description: string;
  highlights: string[];
  specs: Record<string, string>;
  care: string | null;
  weightGrams: number;
  images: GalleryImage[];
  options: OptionView[];
  variants: VariantView[];
  totalStock: number;
};

export type CategoryNode = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  heroColor: string | null;
  /** Public URL of the CMS-configured Category image; null = use the illustration. */
  imageUrl: string | null;
  featured: boolean;
  children: CategoryNode[];
  productCount?: number;
};

/**
 * Fully-resolved primary navigation (Phase 5C). Produced server-side by
 * `getResolvedNav()` from the `nav.primary` ContentBlock + the category tree,
 * then handed to the header / mega-menu / mobile-menu as plain, safe data.
 */
export type ResolvedNavChild = {
  label: string;
  href: string;
  productCount?: number;
};

export type ResolvedNavItem = {
  label: string;
  href: string;
  /** From the referenced category (mega-menu panel copy); null for plain links. */
  description: string | null;
  heroColor: string | null;
  /** CMS category image for the mega-menu panel; null → quiet heroColor fallback. */
  imageUrl: string | null;
  /** True when the destination is the Sale collection — preserves the accent styling. */
  isSale: boolean;
  children: ResolvedNavChild[];
};

export type ResolvedNav = {
  items: ResolvedNavItem[];
  utility: { label: string; href: string }[];
};

export type ReviewView = {
  id: string;
  rating: number;
  title: string | null;
  body: string;
  author: string;
  verified: boolean;
  createdAt: string;
};
