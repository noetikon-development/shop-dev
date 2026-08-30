import "server-only";
import { unstable_cache } from "next/cache";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { artKindFromRef } from "@/lib/art-ref";
import { stockStatusFromAvailable, rollupStatus } from "@/lib/inventory-status";
import type {
  CategoryNode,
  ProductCardView,
  ProductDetailView,
  ReviewView,
} from "@/lib/types";
import type { SortId } from "@/lib/constants";

function safeParse<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const cardSelect = {
  id: true,
  slug: true,
  name: true,
  brand: true,
  shortDescription: true,
  price: true,
  compareAtPrice: true,
  ratingAvg: true,
  ratingCount: true,
  soldCount: true,
  badges: true,
  freeShipping: true,
  createdAt: true,
  category: { select: { slug: true, name: true } },
  // Card thumbnail = the product's primary image: a product-level image
  // (optionValueId null) wins over a colour-specific one; then lowest sortOrder;
  // id breaks ties so the pick is stable.
  images: {
    orderBy: [
      { optionValueId: { sort: "asc", nulls: "first" } },
      { sortOrder: "asc" },
      { id: "asc" },
    ],
    take: 1,
    select: { url: true, alt: true },
  },
  options: {
    where: { name: "Colour" },
    select: { values: { orderBy: { sortOrder: "asc" }, select: { swatchHex: true } } },
  },
  variants: {
    where: { status: "ACTIVE" },
    select: { id: true, stock: true, inventory: { select: { reorderPoint: true } } },
  },
} satisfies Prisma.ProductSelect;

type CardRow = {
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
  badges: string;
  freeShipping: boolean;
  createdAt: Date;
  category: { slug: string; name: string };
  images: { url: string; alt: string }[];
  options: { values: { swatchHex: string | null }[] }[];
  variants: { id: string; stock: number; inventory: { reorderPoint: number } | null }[];
};

function toCard(p: CardRow): ProductCardView {
  const img = p.images[0] ?? { url: "art:accessory:" + p.slug, alt: p.name };
  const swatches = (p.options[0]?.values ?? [])
    .map((v) => v.swatchHex)
    .filter((h): h is string => Boolean(h));
  const stockStatus = rollupStatus(
    p.variants.map((v) => stockStatusFromAvailable(v.stock, v.inventory?.reorderPoint ?? 0)),
  );
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    shortDescription: p.shortDescription,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    soldCount: p.soldCount,
    badges: safeParse<string[]>(p.badges, []),
    freeShipping: p.freeShipping,
    image: { url: img.url, alt: img.alt },
    art: artKindFromRef(img.url),
    categorySlug: p.category.slug,
    categoryName: p.category.name,
    colorSwatches: swatches,
    inStock: p.variants.some((v) => v.stock > 0),
    stockStatus,
    defaultVariantId: p.variants.length === 1 ? p.variants[0].id : null,
    createdAt: p.createdAt.toISOString(),
  };
}

function orderBy(sort: SortId) {
  switch (sort) {
    case "newest":
      return [{ createdAt: "desc" as const }];
    case "price-asc":
      return [{ price: "asc" as const }];
    case "price-desc":
      return [{ price: "desc" as const }];
    case "rating":
      return [{ ratingAvg: "desc" as const }, { ratingCount: "desc" as const }];
    case "bestselling":
      return [{ soldCount: "desc" as const }];
    default:
      return [{ soldCount: "desc" as const }, { ratingAvg: "desc" as const }];
  }
}

// ---------------------------------------------------------------------------
// Categories — one cached query, everything else derived in memory
// ---------------------------------------------------------------------------

type CategoryRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  heroColor: string | null;
  /** Denormalised public URL of the configured Category image (CMS). */
  imageUrl: string | null;
  featured: boolean;
  sortOrder: number;
  parentId: string | null;
  productCount: number;
};

const loadCategoryRows = unstable_cache(
  async (): Promise<CategoryRow[]> => {
    const cats = await prisma.category.findMany({
      where: { active: true },
      orderBy: { sortOrder: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        heroColor: true,
        imageUrl: true,
        featured: true,
        sortOrder: true,
        parentId: true,
        _count: { select: { products: true } },
      },
    });
    return cats.map(({ _count, ...c }) => ({ ...c, productCount: _count.products }));
  },
  ["category-rows"],
  { revalidate: 300, tags: ["categories"] },
);

export async function getCategoryTree(): Promise<CategoryNode[]> {
  const rows = await loadCategoryRows();
  const byId = new Map(
    rows.map((c) => [
      c.id,
      {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        heroColor: c.heroColor,
        imageUrl: c.imageUrl,
        featured: c.featured,
        productCount: c.productCount,
        children: [] as CategoryNode[],
      },
    ]),
  );

  const roots: CategoryNode[] = [];
  for (const c of rows) {
    const node = byId.get(c.id)!;
    if (c.parentId && byId.has(c.parentId)) byId.get(c.parentId)!.children.push(node);
    else roots.push(node);
  }
  for (const r of roots) {
    r.productCount = r.children.reduce((n, ch) => n + (ch.productCount ?? 0), r.productCount ?? 0);
  }
  return roots;
}

export async function getCategoryBySlug(slug: string) {
  const rows = await loadCategoryRows();
  const cat = rows.find((c) => c.slug === slug);
  if (!cat) return null;
  const parent = cat.parentId ? rows.find((c) => c.id === cat.parentId) ?? null : null;
  const children = rows
    .filter((c) => c.parentId === cat.id)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      _count: { products: c.productCount },
    }));
  return {
    id: cat.id,
    name: cat.name,
    slug: cat.slug,
    description: cat.description,
    heroColor: cat.heroColor,
    imageUrl: cat.imageUrl,
    parentId: cat.parentId,
    parent: parent ? { name: parent.name, slug: parent.slug } : null,
    children,
  };
}

async function descendantCategoryIds(categoryId: string): Promise<string[]> {
  const rows = await loadCategoryRows();
  const childrenOf = new Map<string, string[]>();
  for (const c of rows) {
    if (!c.parentId) continue;
    const arr = childrenOf.get(c.parentId);
    if (arr) arr.push(c.id);
    else childrenOf.set(c.parentId, [c.id]);
  }
  const out: string[] = [];
  const stack = [categoryId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    const kids = childrenOf.get(id);
    if (kids) stack.push(...kids);
  }
  return out;
}

async function categoryIdBySlug(slug: string): Promise<string | null> {
  const rows = await loadCategoryRows();
  return rows.find((c) => c.slug === slug)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Product listing
// ---------------------------------------------------------------------------

export type ListingParams = {
  categorySlug?: string;
  query?: string;
  sort?: SortId;
  minPrice?: number;
  maxPrice?: number;
  colors?: string[];
  onSale?: boolean;
  inStock?: boolean;
  freeShipping?: boolean;
  minRating?: number;
  page?: number;
  perPage?: number;
};

export type ListingResult = {
  products: ProductCardView[];
  total: number;
  page: number;
  perPage: number;
  pageCount: number;
  priceBounds: { min: number; max: number };
  colorFacets: { name: string; hex: string | null; count: number }[];
};

async function runListProducts(params: ListingParams): Promise<ListingResult> {
  const perPage = params.perPage ?? 24;
  const page = Math.max(1, params.page ?? 1);

  let categoryIds: string[] | undefined;
  if (params.categorySlug) {
    const catId = await categoryIdBySlug(params.categorySlug);
    if (!catId) {
      return {
        products: [],
        total: 0,
        page,
        perPage,
        pageCount: 0,
        priceBounds: { min: 0, max: 0 },
        colorFacets: [],
      };
    }
    categoryIds = await descendantCategoryIds(catId);
  }

  const AND: Record<string, unknown>[] = [{ status: "ACTIVE" }];
  if (categoryIds) AND.push({ categoryId: { in: categoryIds } });
  if (params.query) {
    const q = params.query.trim();
    AND.push({
      OR: [
        { name: { contains: q } },
        { shortDescription: { contains: q } },
        { description: { contains: q } },
        { brand: { contains: q } },
        { category: { name: { contains: q } } },
      ],
    });
  }
  if (params.minPrice != null) AND.push({ price: { gte: params.minPrice } });
  if (params.maxPrice != null) AND.push({ price: { lte: params.maxPrice } });
  if (params.onSale) AND.push({ compareAtPrice: { not: null } });
  if (params.freeShipping) AND.push({ freeShipping: true });
  if (params.minRating) AND.push({ ratingAvg: { gte: params.minRating } });
  if (params.colors?.length) {
    AND.push({
      options: {
        some: {
          name: "Colour",
          values: { some: { value: { in: params.colors } } },
        },
      },
    });
  }
  if (params.inStock) {
    AND.push({ variants: { some: { stock: { gt: 0 } } } });
  }

  const where = { AND };

  const [rows, total, priceAgg, colorGroups] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy: orderBy(params.sort ?? "relevance"),
      skip: (page - 1) * perPage,
      take: perPage,
      select: cardSelect,
    }),
    prisma.product.count({ where }),
    prisma.product.aggregate({
      where: categoryIds ? { status: "ACTIVE", categoryId: { in: categoryIds } } : { status: "ACTIVE" },
      _min: { price: true },
      _max: { price: true },
    }),
    prisma.productOptionValue.findMany({
      where: {
        option: {
          name: "Colour",
          product: categoryIds
            ? { status: "ACTIVE", categoryId: { in: categoryIds } }
            : { status: "ACTIVE" },
        },
      },
      select: { value: true, swatchHex: true },
    }),
  ]);

  const colorMap = new Map<string, { name: string; hex: string | null; count: number }>();
  for (const c of colorGroups) {
    const existing = colorMap.get(c.value);
    if (existing) existing.count += 1;
    else colorMap.set(c.value, { name: c.value, hex: c.swatchHex, count: 1 });
  }

  return {
    products: (rows as unknown as CardRow[]).map(toCard),
    total,
    page,
    perPage,
    pageCount: Math.max(1, Math.ceil(total / perPage)),
    priceBounds: {
      min: priceAgg._min.price ?? 0,
      max: priceAgg._max.price ?? 0,
    },
    colorFacets: [...colorMap.values()].sort((a, b) => b.count - a.count),
  };
}

export const listProducts = unstable_cache(runListProducts, ["list-products"], {
  revalidate: 60,
  tags: ["products"],
});

// ---------------------------------------------------------------------------
// Homepage helpers — cached; the same for everyone, changes rarely
// ---------------------------------------------------------------------------

const rail = (
  key: string,
  where: Record<string, unknown>,
  orderBy: Record<string, "asc" | "desc">,
) =>
  unstable_cache(
    async (take: number): Promise<ProductCardView[]> => {
      const rows = await prisma.product.findMany({ where, orderBy, take, select: cardSelect });
      return (rows as unknown as CardRow[]).map(toCard);
    },
    [`rail-${key}`],
    { revalidate: 180, tags: ["products"] },
  );

const bestSellersRail = rail("bestsellers", { status: "ACTIVE" }, { soldCount: "desc" });
const newArrivalsRail = rail("new-arrivals", { status: "ACTIVE" }, { createdAt: "desc" });
const onSaleRail = rail(
  "on-sale",
  { status: "ACTIVE", compareAtPrice: { not: null } },
  { soldCount: "desc" },
);

export const getBestSellers = (take = 8) => bestSellersRail(take);
export const getNewArrivals = (take = 8) => newArrivalsRail(take);
export const getOnSale = (take = 8) => onSaleRail(take);

export async function getProductsByBadge(badge: string, take = 8): Promise<ProductCardView[]> {
  const run = unstable_cache(
    async (b: string, t: number) => {
      const rows = await prisma.product.findMany({
        where: { status: "ACTIVE", badges: { contains: `"${b}"` } },
        orderBy: { soldCount: "desc" },
        take: t,
        select: cardSelect,
      });
      return (rows as unknown as CardRow[]).map(toCard);
    },
    ["rail-badge"],
    { revalidate: 180, tags: ["products"] },
  );
  return run(badge, take);
}

// ---------------------------------------------------------------------------
// Product detail
// ---------------------------------------------------------------------------

async function loadProductBySlug(slug: string): Promise<ProductDetailView | null> {
  const p = await prisma.product.findFirst({
    where: { slug, status: "ACTIVE" },
    include: {
      category: { select: { slug: true, name: true } },
      // Ordered so that, within each (colour / product-level) group, the lowest
      // sortOrder comes first — that image is the group's primary. `id` breaks
      // ties. The PDP groups these by `optionValueId` in the client.
      images: { orderBy: [{ sortOrder: "asc" }, { id: "asc" }] },
      options: {
        orderBy: { sortOrder: "asc" },
        include: { values: { orderBy: { sortOrder: "asc" } } },
      },
      variants: {
        include: {
          optionValues: { select: { optionValueId: true } },
          inventory: { select: { reorderPoint: true } },
        },
      },
    },
  });
  if (!p) return null;

  // Card / hero primary image: a product-level image (optionValueId null) wins;
  // otherwise the first image overall (already ordered by sortOrder, then id).
  const primaryImg =
    p.images.find((i) => i.optionValueId == null) ??
    p.images[0] ?? { url: `art:accessory:${p.slug}`, alt: p.name };
  const swatches = (p.options.find((o) => o.name === "Colour")?.values ?? [])
    .map((v) => v.swatchHex)
    .filter((h): h is string => Boolean(h));
  const activeVariants = p.variants.filter((v) => v.status === "ACTIVE");
  const totalStock = activeVariants.reduce((n, v) => n + Math.max(0, v.stock), 0);

  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    brand: p.brand,
    shortDescription: p.shortDescription,
    description: p.description,
    price: p.price,
    compareAtPrice: p.compareAtPrice,
    ratingAvg: p.ratingAvg,
    ratingCount: p.ratingCount,
    soldCount: p.soldCount,
    badges: safeParse<string[]>(p.badges, []),
    highlights: safeParse<string[]>(p.highlights, []),
    specs: safeParse<Record<string, string>>(p.specs, {}),
    care: p.care,
    weightGrams: p.weightGrams,
    freeShipping: p.freeShipping,
    image: { url: primaryImg.url, alt: primaryImg.alt },
    images: p.images.map((i) => ({
      url: i.url,
      alt: i.alt,
      optionValueId: i.optionValueId ?? null,
    })),
    art: artKindFromRef(primaryImg.url),
    categorySlug: p.category.slug,
    categoryName: p.category.name,
    colorSwatches: swatches,
    inStock: totalStock > 0,
    stockStatus: rollupStatus(
      activeVariants.map((v) =>
        stockStatusFromAvailable(v.stock, v.inventory?.reorderPoint ?? 0),
      ),
    ),
    defaultVariantId: activeVariants.length === 1 ? activeVariants[0].id : null,
    totalStock,
    createdAt: p.createdAt.toISOString(),
    options: p.options.map((o) => ({
      id: o.id,
      name: o.name,
      values: o.values.map((v) => ({ id: v.id, value: v.value, swatchHex: v.swatchHex })),
    })),
    variants: activeVariants.map((v) => ({
      id: v.id,
      sku: v.sku,
      price: v.price,
      compareAtPrice: v.compareAtPrice,
      stock: Math.max(0, v.stock),
      reorderPoint: v.inventory?.reorderPoint ?? 0,
      status: v.status,
      imageUrl: v.imageUrl,
      optionValueIds: v.optionValues.map((ov) => ov.optionValueId),
    })),
  };
}

export const getProductBySlug = unstable_cache(loadProductBySlug, ["product-by-slug"], {
  revalidate: 120,
  tags: ["products"],
});

export const getRelatedProducts = unstable_cache(
  async (
    categorySlug: string,
    excludeSlug: string,
    take = 6,
  ): Promise<ProductCardView[]> => {
    const rows = await prisma.product.findMany({
      where: { status: "ACTIVE", category: { slug: categorySlug }, slug: { not: excludeSlug } },
      orderBy: { soldCount: "desc" },
      take,
      select: cardSelect,
    });
    return (rows as unknown as CardRow[]).map(toCard);
  },
  ["related-products"],
  { revalidate: 180, tags: ["products"] },
);

/** First name only — keeps the public review identity minimal (Step 15 §32). */
function reviewDisplayName(name: string | null): string {
  const trimmed = (name ?? "").trim();
  if (!trimmed) return "AXIARO customer";
  return trimmed.split(/\s+/)[0];
}

/**
 * Public reviews for a product — APPROVED only (Step 15 §7/§29). PENDING,
 * REJECTED and ARCHIVED reviews are never returned here. Verified purchases are
 * listed first, then newest.
 */
export const getProductReviews = unstable_cache(
  async (productId: string): Promise<ReviewView[]> => {
    const rows = await prisma.review.findMany({
      where: { productId, status: "APPROVED" },
      orderBy: [{ verified: "desc" }, { createdAt: "desc" }],
      take: 50,
      include: { user: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      rating: r.rating,
      title: r.title,
      body: r.body,
      author: reviewDisplayName(r.user.name),
      verified: r.verified,
      createdAt: r.createdAt.toISOString(),
    }));
  },
  ["product-reviews"],
  { revalidate: 300, tags: ["products"] },
);

export type ReviewSummary = {
  avg: number;
  count: number;
  /** number of APPROVED reviews at each star level */
  distribution: Record<1 | 2 | 3 | 4 | 5, number>;
};

/**
 * Rating summary computed from APPROVED reviews in the database (Step 15 §29) —
 * never trusts a browser-supplied summary. The denormalised
 * `Product.ratingAvg` / `ratingCount` are kept in step with this by the review
 * actions, but this recomputes the full distribution for the product page.
 */
export const getReviewSummary = unstable_cache(
  async (productId: string): Promise<ReviewSummary> => {
    const groups = await prisma.review.groupBy({
      by: ["rating"],
      where: { productId, status: "APPROVED" },
      _count: { _all: true },
    });
    const distribution: ReviewSummary["distribution"] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0;
    let count = 0;
    for (const g of groups) {
      const star = Math.min(5, Math.max(1, g.rating)) as 1 | 2 | 3 | 4 | 5;
      distribution[star] += g._count._all;
      sum += g.rating * g._count._all;
      count += g._count._all;
    }
    return {
      avg: count > 0 ? Math.round((sum / count) * 10) / 10 : 0,
      count,
      distribution,
    };
  },
  ["product-review-summary"],
  { revalidate: 300, tags: ["products"] },
);

export async function getProductCardsBySlugs(slugs: string[]): Promise<ProductCardView[]> {
  if (!slugs.length) return [];
  const rows = await prisma.product.findMany({
    where: { slug: { in: slugs }, status: "ACTIVE" },
    select: cardSelect,
  });
  const cards = (rows as unknown as CardRow[]).map(toCard);
  const order = new Map(slugs.map((s, i) => [s, i]));
  return cards.sort((a, b) => (order.get(a.slug) ?? 0) - (order.get(b.slug) ?? 0));
}

/** For CMS product rails with a hand-picked list. Preserves the given order. */
export const getProductCardsByIds = unstable_cache(
  async (ids: string[]): Promise<ProductCardView[]> => {
    if (!ids.length) return [];
    const rows = await prisma.product.findMany({
      where: { id: { in: ids }, status: "ACTIVE" },
      select: cardSelect,
    });
    const cards = (rows as unknown as CardRow[]).map(toCard);
    const order = new Map(ids.map((s, i) => [s, i]));
    return cards.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  },
  ["cms-product-cards-by-id"],
  { revalidate: 120, tags: ["products", "content"] },
);

/** For CMS product rails scoped to a category. */
export const getCategoryRail = unstable_cache(
  async (categorySlug: string, take = 10): Promise<ProductCardView[]> => {
    if (!categorySlug) return [];
    const rows = await prisma.product.findMany({
      where: { status: "ACTIVE", category: { slug: categorySlug } },
      orderBy: { soldCount: "desc" },
      take,
      select: cardSelect,
    });
    return (rows as unknown as CardRow[]).map(toCard);
  },
  ["cms-category-rail"],
  { revalidate: 120, tags: ["products", "content"] },
);

export async function getAllProductSlugs() {
  const rows = await prisma.product.findMany({ select: { slug: true } });
  return rows.map((r) => r.slug);
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderView = Awaited<ReturnType<typeof getOrderByNumber>>;

export async function getOrderByNumber(orderNumber: string) {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    include: {
      items: true,
      events: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!order) return null;
  return {
    ...order,
    shippingAddress: safeParse<Record<string, string>>(order.shippingAddress, {}),
    billingAddress: order.billingAddress
      ? safeParse<Record<string, string>>(order.billingAddress, {})
      : null,
  };
}

/**
 * Public order tracking (Step 13). Looked up by order number + the email used at
 * checkout. Returns ONLY information that is safe to show on the public /track
 * page — no customer email/phone, no address, no billing, no prices, no internal
 * fulfilment note, and no free-text event detail (which could carry an admin's
 * cancellation reason). Returns null when the order number or email don't match.
 */
export async function getPublicTracking(orderNumber: string, email: string) {
  const order = await prisma.order.findUnique({
    where: { orderNumber },
    select: {
      orderNumber: true,
      email: true,
      status: true,
      placedAt: true,
      shippingMethodCode: true,
      shippingMethodName: true,
      courier: true,
      courierName: true,
      trackingNumber: true,
      trackingUrl: true,
      shippedAt: true,
      deliveredAt: true,
      items: { select: { name: true, variantLabel: true, quantity: true }, orderBy: { id: "asc" } },
      events: {
        orderBy: { createdAt: "asc" },
        select: { status: true, title: true, location: true, createdAt: true },
      },
    },
  });
  if (!order) return null;
  if (!email || order.email.trim().toLowerCase() !== email.trim().toLowerCase()) return null;

  const { email: _omit, ...safe } = order;
  void _omit;
  return safe;
}

export type PublicTracking = NonNullable<Awaited<ReturnType<typeof getPublicTracking>>>;

export async function getUserOrders(userId: string) {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { placedAt: "desc" },
    include: { items: true },
  });
  return orders.map((o) => ({
    ...o,
    shippingAddress: safeParse<Record<string, string>>(o.shippingAddress, {}),
    billingAddress: o.billingAddress
      ? safeParse<Record<string, string>>(o.billingAddress, {})
      : null,
  }));
}

export async function searchSuggestions(q: string, take = 6) {
  if (!q.trim()) return [];
  const rows = await prisma.product.findMany({
    where: {
      status: "ACTIVE",
      OR: [{ name: { contains: q } }, { brand: { contains: q } }, { shortDescription: { contains: q } }],
    },
    orderBy: { soldCount: "desc" },
    take,
    select: {
      slug: true,
      name: true,
      price: true,
      category: { select: { name: true } },
      images: {
        orderBy: [
          { optionValueId: { sort: "asc", nulls: "first" } },
          { sortOrder: "asc" },
          { id: "asc" },
        ],
        take: 1,
        select: { url: true },
      },
    },
  });
  return rows.map((r) => ({
    slug: r.slug,
    name: r.name,
    price: r.price,
    category: r.category.name,
    art: artKindFromRef(r.images[0]?.url),
  }));
}
