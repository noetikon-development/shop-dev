import "server-only";
import { prisma } from "@/lib/prisma";
import { slugify } from "@/lib/utils";

/**
 * Read layer for admin catalog management. Unlike src/lib/data.ts (the
 * storefront read layer, which is cached and only returns ACTIVE items), these
 * queries are uncached and return every status so admins can see drafts and
 * archived items.
 */

export const PRODUCT_PAGE_SIZE = 20;
export const CATEGORY_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Slug / SKU generation
// ---------------------------------------------------------------------------

async function uniqueSlug(
  base: string,
  exists: (slug: string) => Promise<boolean>,
): Promise<string> {
  const root = slugify(base).slice(0, 110) || "item";
  if (!(await exists(root))) return root;
  for (let i = 2; i < 500; i++) {
    const candidate = `${root}-${i}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

export function generateProductSlug(name: string, excludeId?: string) {
  return uniqueSlug(name, async (slug) => {
    const hit = await prisma.product.findUnique({ where: { slug }, select: { id: true } });
    return Boolean(hit && hit.id !== excludeId);
  });
}

export function generateCategorySlug(name: string, excludeId?: string) {
  return uniqueSlug(name, async (slug) => {
    const hit = await prisma.category.findUnique({ where: { slug }, select: { id: true } });
    return Boolean(hit && hit.id !== excludeId);
  });
}

export async function skuInUse(sku: string, excludeVariantId?: string): Promise<boolean> {
  const hit = await prisma.variant.findUnique({ where: { sku }, select: { id: true } });
  return Boolean(hit && hit.id !== excludeVariantId);
}

export async function generateVariantSku(productSlug: string, hint?: string): Promise<string> {
  const base = slugify(`${productSlug}${hint ? `-${hint}` : ""}`)
    .toUpperCase()
    .replace(/-/g, "-")
    .slice(0, 40) || "SKU";
  if (!(await skuInUse(base))) return base;
  for (let i = 2; i < 500; i++) {
    const candidate = `${base}-${i}`;
    if (!(await skuInUse(candidate))) return candidate;
  }
  return `${base}-${Date.now().toString(36).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export type AdminProductFilters = {
  q?: string;
  status?: string;
  categoryId?: string;
  featured?: boolean;
  sort?: string;
  page?: number;
};

export async function listAdminProducts(filters: AdminProductFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Record<string, unknown> = {};
  const AND: Record<string, unknown>[] = [];

  if (filters.q) {
    const q = filters.q.trim();
    AND.push({
      OR: [
        { name: { contains: q, mode: "insensitive" } },
        { slug: { contains: q, mode: "insensitive" } },
        { variants: { some: { sku: { contains: q, mode: "insensitive" } } } },
      ],
    });
  }
  if (filters.status && ["DRAFT", "ACTIVE", "ARCHIVED"].includes(filters.status)) {
    AND.push({ status: filters.status });
  }
  if (filters.categoryId) AND.push({ categoryId: filters.categoryId });
  if (filters.featured) AND.push({ featured: true });
  if (AND.length) where.AND = AND;

  const orderBy = (() => {
    switch (filters.sort) {
      case "name":
        return { name: "asc" as const };
      case "price-asc":
        return { price: "asc" as const };
      case "price-desc":
        return { price: "desc" as const };
      case "oldest":
        return { createdAt: "asc" as const };
      case "updated":
      default:
        return { updatedAt: "desc" as const };
    }
  })();

  const [rows, total] = await Promise.all([
    prisma.product.findMany({
      where,
      orderBy,
      skip: (page - 1) * PRODUCT_PAGE_SIZE,
      take: PRODUCT_PAGE_SIZE,
      select: {
        id: true,
        name: true,
        slug: true,
        status: true,
        featured: true,
        price: true,
        compareAtPrice: true,
        updatedAt: true,
        category: { select: { id: true, name: true } },
        images: { orderBy: { sortOrder: "asc" }, take: 1, select: { url: true, alt: true } },
        _count: { select: { variants: true, images: true } },
      },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    rows,
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PRODUCT_PAGE_SIZE)),
  };
}

export async function getAdminProduct(id: string) {
  return prisma.product.findUnique({
    where: { id },
    include: {
      category: { select: { id: true, name: true, slug: true } },
      images: {
        orderBy: { sortOrder: "asc" },
        include: { mediaAsset: { select: { id: true, sizeBytes: true, mimeType: true } } },
      },
      options: {
        orderBy: { sortOrder: "asc" },
        include: { values: { orderBy: { sortOrder: "asc" } } },
      },
      variants: {
        orderBy: { sku: "asc" },
        include: {
          optionValues: { select: { optionValueId: true } },
          _count: { select: { orderItems: true } },
        },
      },
    },
  });
}

export type AdminProduct = NonNullable<Awaited<ReturnType<typeof getAdminProduct>>>;

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function listAdminCategories(q?: string) {
  const where = q
    ? {
        OR: [
          { name: { contains: q.trim(), mode: "insensitive" as const } },
          { slug: { contains: q.trim(), mode: "insensitive" as const } },
        ],
      }
    : {};

  const rows = await prisma.category.findMany({
    where,
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      slug: true,
      active: true,
      featured: true,
      sortOrder: true,
      imageUrl: true,
      parentId: true,
      parent: { select: { name: true } },
      _count: { select: { products: true, children: true } },
    },
  });
  return rows;
}

export async function getAdminCategory(id: string) {
  return prisma.category.findUnique({
    where: { id },
    include: {
      parent: { select: { id: true, name: true } },
      imageMedia: { select: { id: true, url: true, filename: true } },
      _count: { select: { products: true, children: true } },
    },
  });
}

/** Flat, tree-ordered list for <Select> options (create/edit forms). */
export async function categorySelectOptions(excludeId?: string) {
  const cats = await prisma.category.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { id: true, name: true, parentId: true, active: true },
  });
  const childrenOf = new Map<string | null, typeof cats>();
  for (const c of cats) {
    const key = c.parentId;
    const arr = childrenOf.get(key) ?? [];
    arr.push(c);
    childrenOf.set(key, arr);
  }
  const out: { id: string; label: string; active: boolean }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const c of childrenOf.get(parentId) ?? []) {
      if (c.id === excludeId) continue;
      out.push({
        id: c.id,
        label: `${"— ".repeat(depth)}${c.name}${c.active ? "" : " (inactive)"}`,
        active: c.active,
      });
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

// ---------------------------------------------------------------------------
// Variants (global list for /admin/variants)
// ---------------------------------------------------------------------------

export async function listAdminVariants(q?: string, page = 1) {
  const size = 30;
  const where = q
    ? {
        OR: [
          { sku: { contains: q.trim(), mode: "insensitive" as const } },
          { product: { name: { contains: q.trim(), mode: "insensitive" as const } } },
        ],
      }
    : {};
  const [rows, total] = await Promise.all([
    prisma.variant.findMany({
      where,
      orderBy: [{ product: { name: "asc" } }, { sku: "asc" }],
      skip: (Math.max(1, page) - 1) * size,
      take: size,
      select: {
        id: true,
        sku: true,
        price: true,
        compareAtPrice: true,
        status: true,
        product: { select: { id: true, name: true, slug: true } },
        optionValues: {
          select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
        },
      },
    }),
    prisma.variant.count({ where }),
  ]);
  return { rows, total, page: Math.max(1, page), pageCount: Math.max(1, Math.ceil(total / size)) };
}
