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
  price: number;
  compareAtPrice: number | null;
  stock: number; // available (quantity - reserved)
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
  price: number;
  compareAtPrice: number | null;
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
  featured: boolean;
  children: CategoryNode[];
  productCount?: number;
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
