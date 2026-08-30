"use server";

import { redirect } from "next/navigation";
import { revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { uploadMedia, deleteMedia } from "@/lib/admin/media";
import { regenerateVariants } from "@/lib/admin/variants";
import {
  productCreateSchema,
  productUpdateSchema,
  categorySchema,
  variantUpdateSchema,
  productOptionsSchema,
  pesosToCentavos,
  formBool,
  PRODUCT_STATUSES,
} from "@/lib/admin/catalog-schemas";
import {
  generateProductSlug,
  generateCategorySlug,
  skuInUse,
  generateVariantSku,
} from "@/lib/admin/catalog";

const CATALOG_MEDIA_MAX = 8 * 1024 * 1024;

function revalidateStorefront() {
  revalidateTag("products", "max");
  revalidateTag("categories", "max");
}

type FieldErrors = Record<string, string>;
export type CatalogState = {
  error?: string;
  fieldErrors?: FieldErrors;
  ok?: boolean;
  message?: string;
};

function zodFieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = i.path[0] != null ? String(i.path[0]) : "_";
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

// ===========================================================================
// Products
// ===========================================================================

function readProductForm(formData: FormData) {
  const rawCompare = pesosToCentavos(formData.get("compareAtPrice"));
  return {
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? "").trim(),
    shortDescription: String(formData.get("shortDescription") ?? ""),
    description: String(formData.get("description") ?? ""),
    categoryId: String(formData.get("categoryId") ?? ""),
    status: String(formData.get("status") ?? "DRAFT"),
    featured: formBool(formData.get("featured")),
    freeShipping: formBool(formData.get("freeShipping")),
    price: pesosToCentavos(formData.get("price")) ?? NaN,
    compareAtPrice: rawCompare === null || Number.isNaN(rawCompare) ? null : rawCompare,
    weightGrams: Number(formData.get("weightGrams") ?? 500) || 500,
  };
}

export async function createProduct(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("create_products");

  const input = readProductForm(formData);
  let sku = String(formData.get("sku") ?? "").trim();
  const slugProvided = input.slug.length > 0;
  if (!slugProvided) input.slug = await generateProductSlug(input.name || "product");
  if (!sku) sku = await generateVariantSku(input.slug);

  const parsed = productCreateSchema.safeParse({ ...input, sku });
  if (!parsed.success) {
    return { error: "Please fix the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error.issues) };
  }
  const data = parsed.data;

  const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
  if (!category) return { error: "That category no longer exists.", fieldErrors: { categoryId: "Choose a valid category" } };

  // Slug + SKU uniqueness (DB also enforces via @unique).
  if (slugProvided) {
    const slugTaken = await prisma.product.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (slugTaken) return { error: "That slug is already in use.", fieldErrors: { slug: "Already in use" } };
  }
  if (await skuInUse(data.sku)) return { error: "That SKU is already in use.", fieldErrors: { sku: "Already in use" } };

  let productId: string;
  try {
    const product = await prisma.product.create({
      data: {
        name: data.name,
        slug: data.slug,
        shortDescription: data.shortDescription,
        description: data.description,
        categoryId: data.categoryId,
        status: data.status,
        featured: data.featured,
        freeShipping: data.freeShipping,
        price: data.price,
        compareAtPrice: data.compareAtPrice ?? null,
        weightGrams: data.weightGrams ?? 500,
      },
    });
    productId = product.id;

    const variant = await prisma.variant.create({
      data: {
        productId: product.id,
        sku: data.sku,
        price: data.price,
        compareAtPrice: data.compareAtPrice ?? null,
        status: "ACTIVE",
        stock: 0,
      },
    });
    await prisma.inventory.create({
      data: { variantId: variant.id, sku: data.sku, quantity: 0, reserved: 0, reorderPoint: 3 },
    });
  } catch (err) {
    console.error("[createProduct]", err);
    return { error: "Could not create the product. The slug or SKU may already be taken." };
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.created",
    targetType: "product",
    targetId: productId,
    summary: `${admin.user.email} created product “${data.name}”`,
    meta: { slug: data.slug, status: data.status, price: data.price },
  });
  revalidateStorefront();
  redirect(`/admin/products/${productId}`);
}

export async function updateProduct(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_products");
  const id = String(formData.get("id") ?? "");
  const existing = await prisma.product.findUnique({
    where: { id },
    include: { variants: { select: { id: true, sku: true } } },
  });
  if (!existing) return { error: "That product no longer exists." };

  const input = readProductForm(formData);
  if (!input.slug) input.slug = existing.slug;

  const parsed = productUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Please fix the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error.issues) };
  }
  const data = parsed.data;

  const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
  if (!category) return { error: "That category no longer exists.", fieldErrors: { categoryId: "Choose a valid category" } };

  if (data.slug !== existing.slug) {
    const taken = await prisma.product.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (taken && taken.id !== id) {
      return { error: "That slug is already in use.", fieldErrors: { slug: "Already in use" } };
    }
  }

  try {
    await prisma.product.update({
      where: { id },
      data: {
        name: data.name,
        slug: data.slug,
        shortDescription: data.shortDescription,
        description: data.description,
        categoryId: data.categoryId,
        status: data.status,
        featured: data.featured,
        freeShipping: data.freeShipping,
        price: data.price,
        compareAtPrice: data.compareAtPrice ?? null,
        weightGrams: data.weightGrams ?? 500,
      },
    });

    // Single-variant product: keep the default variant's price in step with the
    // product price so the storefront (which reads the variant) matches.
    if (existing.variants.length === 1) {
      await prisma.variant.update({
        where: { id: existing.variants[0].id },
        data: { price: data.price, compareAtPrice: data.compareAtPrice ?? null },
      });
    }
  } catch (err) {
    console.error("[updateProduct]", err);
    return { error: "Could not save the product." };
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.updated",
    targetType: "product",
    targetId: id,
    summary: `${admin.user.email} updated product “${data.name}”`,
    meta: { slug: data.slug, status: data.status },
  });
  revalidateStorefront();
  return { ok: true, message: "Product saved." };
}

export async function setProductStatus(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_products");
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!PRODUCT_STATUSES.includes(status as (typeof PRODUCT_STATUSES)[number])) {
    return { error: "Invalid status." };
  }
  const product = await prisma.product.findUnique({ where: { id }, select: { name: true } });
  if (!product) return { error: "That product no longer exists." };

  await prisma.product.update({ where: { id }, data: { status } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: status === "ARCHIVED" ? "catalog.product.archived" : "catalog.product.updated",
    targetType: "product",
    targetId: id,
    summary: `${admin.user.email} set “${product.name}” to ${status}`,
    meta: { status },
  });
  revalidateStorefront();
  return { ok: true, message: `Product ${status.toLowerCase()}.` };
}

export async function deleteProduct(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("delete_products");
  const id = String(formData.get("id") ?? "");
  const product = await prisma.product.findUnique({
    where: { id },
    select: {
      name: true,
      _count: { select: { reviews: true, wishedBy: true } },
      variants: { select: { _count: { select: { orderItems: true } } } },
      images: { select: { mediaAssetId: true } },
    },
  });
  if (!product) return { error: "That product no longer exists." };

  const orderItems = product.variants.reduce((n, v) => n + v._count.orderItems, 0);
  if (orderItems > 0 || product._count.reviews > 0 || product._count.wishedBy > 0) {
    return {
      error: `This product has order history, reviews or wishlist entries and can’t be deleted. Archive it instead.`,
    };
  }

  // Pristine product — safe hard delete (cascades to images / options / variants).
  await prisma.$transaction([
    prisma.inventory.deleteMany({ where: { variant: { productId: id } } }),
    prisma.product.delete({ where: { id } }),
  ]);
  // Clean up the uploaded image files (Storage + MediaAsset) that the cascade
  // only unlinked.
  for (const img of product.images) {
    if (img.mediaAssetId) await deleteMedia(img.mediaAssetId).catch(() => {});
  }
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.deleted",
    targetType: "product",
    targetId: id,
    summary: `${admin.user.email} deleted product “${product.name}”`,
  });
  revalidateStorefront();
  redirect("/admin/products");
}

// ===========================================================================
// Product images
// ===========================================================================

/**
 * The set of Colour option-value ids for a product. An image may be attached to
 * one of these (colour-specific) or to nothing (product-level / all colours).
 */
async function colourValueIds(productId: string): Promise<Set<string>> {
  const values = await prisma.productOptionValue.findMany({
    where: { option: { productId, name: "Colour" } },
    select: { id: true },
  });
  return new Set(values.map((v) => v.id));
}

/**
 * Resolve a client-supplied colour choice for an image association.
 *   ""  / "__product"  → null  (product-level, applies to all colours)
 *   a valid Colour value id for this product → that id
 *   anything else → undefined (invalid — the caller rejects it)
 * The association is ALWAYS explicit; nothing is inferred from the filename,
 * slug, image metadata or upload order.
 */
async function resolveImageColour(
  productId: string,
  raw: string,
): Promise<string | null | undefined> {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "__product") return null;
  const valid = await colourValueIds(productId);
  return valid.has(trimmed) ? trimmed : undefined;
}

/** Re-number one (productId, optionValueId) group's images to 0,1,2,… */
async function resequenceImageGroup(productId: string, optionValueId: string | null) {
  const images = await prisma.productImage.findMany({
    where: { productId, optionValueId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  await prisma.$transaction(
    images.map((img, index) =>
      prisma.productImage.update({ where: { id: img.id }, data: { sortOrder: index } }),
    ),
  );
}

export async function uploadProductImage(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("manage_product_images");
  const productId = String(formData.get("productId") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image to upload." };
  if (file.size > CATALOG_MEDIA_MAX) return { error: "Image is too large (max 8 MB)." };

  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, name: true },
  });
  if (!product) return { error: "That product no longer exists." };

  const optionValueId = await resolveImageColour(productId, String(formData.get("optionValueId") ?? ""));
  if (optionValueId === undefined) {
    return { error: "Choose a valid colour for this image, or “Product-level (all colours)”." };
  }

  const result = await uploadMedia({ file, folder: "products" });
  if (!result.ok) return { error: result.error };

  // sortOrder is scoped to the (product, colour) group — the new image goes last.
  const groupCount = await prisma.productImage.count({ where: { productId, optionValueId } });
  const image = await prisma.productImage.create({
    data: {
      productId,
      optionValueId,
      url: result.asset.url,
      alt: String(formData.get("alt") ?? "").trim() || product.name,
      sortOrder: groupCount,
      mediaAssetId: result.asset.id,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.image.uploaded",
    targetType: "product",
    targetId: productId,
    summary: `${admin.user.email} added an image to “${product.name}”`,
    meta: { imageId: image.id, filename: result.asset.filename, optionValueId },
  });
  revalidateStorefront();
  return { ok: true, message: "Image uploaded." };
}

export async function deleteProductImage(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("manage_product_images");
  const imageId = String(formData.get("imageId") ?? "");
  const image = await prisma.productImage.findUnique({
    where: { id: imageId },
    include: { product: { select: { id: true, name: true } } },
  });
  if (!image) return { error: "That image no longer exists." };

  await prisma.productImage.delete({ where: { id: imageId } });
  if (image.mediaAssetId) {
    await deleteMedia(image.mediaAssetId).catch((e) => console.error("[deleteProductImage] media", e));
  }
  await resequenceImageGroup(image.productId, image.optionValueId);

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.image.deleted",
    targetType: "product",
    targetId: image.productId,
    summary: `${admin.user.email} removed an image from “${image.product.name}”`,
    meta: { imageId, optionValueId: image.optionValueId },
  });
  revalidateStorefront();
  return { ok: true };
}

/** Move an existing image to a different colour group (or to product-level). */
export async function setImageColour(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("manage_product_images");
  const imageId = String(formData.get("imageId") ?? "");
  const image = await prisma.productImage.findUnique({
    where: { id: imageId },
    include: { product: { select: { id: true, name: true } } },
  });
  if (!image) return { error: "That image no longer exists." };

  const next = await resolveImageColour(image.productId, String(formData.get("optionValueId") ?? ""));
  if (next === undefined) return { error: "That colour isn’t valid for this product." };
  if (next === image.optionValueId) return { ok: true };

  const from = image.optionValueId;
  const groupCount = await prisma.productImage.count({
    where: { productId: image.productId, optionValueId: next },
  });
  await prisma.productImage.update({
    where: { id: imageId },
    data: { optionValueId: next, sortOrder: groupCount }, // append to the target group
  });
  await resequenceImageGroup(image.productId, from);
  await resequenceImageGroup(image.productId, next);

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.image.recoloured",
    targetType: "product",
    targetId: image.productId,
    summary: `${admin.user.email} reassigned an image on “${image.product.name}”`,
    meta: { imageId, from, to: next },
  });
  revalidateStorefront();
  return { ok: true };
}

export async function reorderProductImages(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("manage_product_images");
  const productId = String(formData.get("productId") ?? "");
  const optionValueId = await resolveImageColour(productId, String(formData.get("optionValueId") ?? ""));
  if (optionValueId === undefined) return { error: "Unknown colour group." };
  const order = formData.getAll("imageIds").map(String);
  if (order.length === 0) return { error: "Nothing to reorder." };

  // Only images in THIS (product, colour) group may be reordered here.
  const group = await prisma.productImage.findMany({
    where: { productId, optionValueId },
    select: { id: true },
  });
  const owned = new Set(group.map((i) => i.id));
  if (!order.every((id) => owned.has(id)) || order.length !== group.length) {
    return { error: "Image list is out of sync — reload and try again." };
  }

  await prisma.$transaction(
    order.map((id, index) =>
      prisma.productImage.update({ where: { id }, data: { sortOrder: index } }),
    ),
  );
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.image.reordered",
    targetType: "product",
    targetId: productId,
    summary: `${admin.user.email} reordered product images`,
    meta: { optionValueId },
  });
  revalidateStorefront();
  return { ok: true };
}

// ===========================================================================
// Categories
// ===========================================================================

function readCategoryForm(formData: FormData) {
  return {
    name: String(formData.get("name") ?? ""),
    slug: String(formData.get("slug") ?? "").trim(),
    description: String(formData.get("description") ?? "").trim(),
    parentId: String(formData.get("parentId") ?? "").trim(),
    heroColor: String(formData.get("heroColor") ?? "").trim(),
    sortOrder: Number(formData.get("sortOrder") ?? 0) || 0,
    featured: formBool(formData.get("featured")),
    active: formBool(formData.get("active")),
  };
}

export async function createCategory(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("create_categories");
  const input = readCategoryForm(formData);
  const slugProvided = input.slug.length > 0;
  if (!slugProvided) input.slug = await generateCategorySlug(input.name || "category");

  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Please fix the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error.issues) };
  }
  const data = parsed.data;

  if (data.parentId) {
    const parent = await prisma.category.findUnique({ where: { id: data.parentId }, select: { id: true } });
    if (!parent) return { error: "That parent category no longer exists.", fieldErrors: { parentId: "Invalid" } };
  }
  if (slugProvided) {
    const taken = await prisma.category.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (taken) return { error: "That slug is already in use.", fieldErrors: { slug: "Already in use" } };
  }

  let categoryId: string;
  try {
    const cat = await prisma.category.create({
      data: {
        name: data.name,
        slug: data.slug,
        description: data.description || null,
        parentId: data.parentId || null,
        heroColor: data.heroColor || null,
        sortOrder: data.sortOrder,
        featured: data.featured,
        active: data.active,
      },
    });
    categoryId = cat.id;
  } catch (err) {
    console.error("[createCategory]", err);
    return { error: "Could not create the category — the slug may already be taken." };
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.category.created",
    targetType: "category",
    targetId: categoryId,
    summary: `${admin.user.email} created category “${data.name}”`,
    meta: { slug: data.slug },
  });
  revalidateStorefront();
  redirect(`/admin/categories/${categoryId}`);
}

export async function updateCategory(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_categories");
  const id = String(formData.get("id") ?? "");
  const existing = await prisma.category.findUnique({ where: { id }, select: { slug: true, name: true } });
  if (!existing) return { error: "That category no longer exists." };

  const input = readCategoryForm(formData);
  if (!input.slug) input.slug = existing.slug;
  const parsed = categorySchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Please fix the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error.issues) };
  }
  const data = parsed.data;

  if (data.parentId === id) {
    return { error: "A category can’t be its own parent.", fieldErrors: { parentId: "Invalid" } };
  }
  if (data.parentId) {
    const parent = await prisma.category.findUnique({ where: { id: data.parentId }, select: { parentId: true } });
    if (!parent) return { error: "That parent category no longer exists.", fieldErrors: { parentId: "Invalid" } };
    if (parent.parentId === id) {
      return { error: "That would create a category loop.", fieldErrors: { parentId: "Invalid" } };
    }
  }
  if (data.slug !== existing.slug) {
    const taken = await prisma.category.findUnique({ where: { slug: data.slug }, select: { id: true } });
    if (taken && taken.id !== id) {
      return { error: "That slug is already in use.", fieldErrors: { slug: "Already in use" } };
    }
  }

  await prisma.category.update({
    where: { id },
    data: {
      name: data.name,
      slug: data.slug,
      description: data.description || null,
      parentId: data.parentId || null,
      heroColor: data.heroColor || null,
      sortOrder: data.sortOrder,
      featured: data.featured,
      active: data.active,
    },
  });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.category.updated",
    targetType: "category",
    targetId: id,
    summary: `${admin.user.email} updated category “${data.name}”`,
    meta: { slug: data.slug, active: data.active },
  });
  revalidateStorefront();
  return { ok: true, message: "Category saved." };
}

export async function reorderCategories(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_categories");
  const moves = formData.getAll("order").map((v) => {
    const [id, sortOrder] = String(v).split(":");
    return { id, sortOrder: Number(sortOrder) };
  });
  if (moves.some((m) => !m.id || !Number.isFinite(m.sortOrder))) {
    return { error: "Invalid ordering data." };
  }
  await prisma.$transaction(
    moves.map((m) => prisma.category.update({ where: { id: m.id }, data: { sortOrder: m.sortOrder } })),
  );
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.category.reordered",
    targetType: "category",
    summary: `${admin.user.email} reordered categories`,
    meta: { count: moves.length },
  });
  revalidateStorefront();
  return { ok: true, message: "Order updated." };
}

export async function setCategoryActive(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_categories");
  const id = String(formData.get("id") ?? "");
  const active = formBool(formData.get("active"));
  const cat = await prisma.category.findUnique({
    where: { id },
    select: { name: true, _count: { select: { products: true, children: true } } },
  });
  if (!cat) return { error: "That category no longer exists." };

  await prisma.category.update({ where: { id }, data: { active } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: active ? "catalog.category.updated" : "catalog.category.archived",
    targetType: "category",
    targetId: id,
    summary: `${admin.user.email} ${active ? "activated" : "deactivated"} category “${cat.name}”`,
    meta: { active, products: cat._count.products },
  });
  revalidateStorefront();
  return {
    ok: true,
    message: active
      ? "Category activated."
      : `Category deactivated${cat._count.products ? ` (${cat._count.products} product${cat._count.products === 1 ? "" : "s"} stay in the catalog)` : ""}.`,
  };
}

export async function deleteCategory(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("delete_categories");
  const id = String(formData.get("id") ?? "");
  const cat = await prisma.category.findUnique({
    where: { id },
    select: { name: true, imageMediaId: true, _count: { select: { products: true, children: true } } },
  });
  if (!cat) return { error: "That category no longer exists." };

  if (cat._count.products > 0 || cat._count.children > 0) {
    return {
      error: `This category has ${cat._count.products} product(s) and ${cat._count.children} sub-categor(y/ies). Reassign or archive it instead.`,
    };
  }

  await prisma.category.delete({ where: { id } });
  if (cat.imageMediaId) await deleteMedia(cat.imageMediaId).catch(() => {});
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.category.deleted",
    targetType: "category",
    targetId: id,
    summary: `${admin.user.email} deleted category “${cat.name}”`,
  });
  revalidateStorefront();
  redirect("/admin/categories");
}

export async function uploadCategoryImage(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_categories");
  const id = String(formData.get("id") ?? "");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose an image." };
  if (file.size > CATALOG_MEDIA_MAX) return { error: "Image is too large (max 8 MB)." };

  const cat = await prisma.category.findUnique({ where: { id }, select: { name: true, imageMediaId: true } });
  if (!cat) return { error: "That category no longer exists." };

  const result = await uploadMedia({ file, folder: "categories" });
  if (!result.ok) return { error: result.error };

  const previous = cat.imageMediaId;
  await prisma.category.update({
    where: { id },
    data: { imageMediaId: result.asset.id, imageUrl: result.asset.url },
  });
  if (previous) await deleteMedia(previous).catch(() => {});

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.category.updated",
    targetType: "category",
    targetId: id,
    summary: `${admin.user.email} set the image for category “${cat.name}”`,
  });
  revalidateStorefront();
  return { ok: true, message: "Category image updated." };
}

export async function removeCategoryImage(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_categories");
  const id = String(formData.get("id") ?? "");
  const cat = await prisma.category.findUnique({ where: { id }, select: { name: true, imageMediaId: true } });
  if (!cat) return { error: "That category no longer exists." };

  await prisma.category.update({ where: { id }, data: { imageMediaId: null, imageUrl: null } });
  if (cat.imageMediaId) await deleteMedia(cat.imageMediaId).catch(() => {});
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.category.updated",
    targetType: "category",
    targetId: id,
    summary: `${admin.user.email} removed the image from category “${cat.name}”`,
  });
  revalidateStorefront();
  return { ok: true };
}

// ===========================================================================
// Variants & options
// ===========================================================================

const SWATCH_HINTS: Record<string, string> = {
  oak: "#c8a97e", walnut: "#6b4a32", oat: "#e8dfce", clay: "#b5533a", sage: "#7c8a71",
  ink: "#23211e", slate: "#4a4f57", black: "#262626", white: "#f2f0ea", natural: "#d8c8ab",
  charcoal: "#3d3d3f", cream: "#efece4", grey: "#9a9a93", gray: "#9a9a93", navy: "#22314a",
  green: "#3f5245", blue: "#5a6b74", terracotta: "#b06b4c", rust: "#a8583f", bone: "#e6e1d6",
};

export async function saveProductOptions(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_products");
  const productId = String(formData.get("productId") ?? "");
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true } });
  if (!product) return { error: "That product no longer exists." };

  let payload: { name: string; values: string[] }[];
  try {
    payload = JSON.parse(String(formData.get("options") ?? "[]"));
  } catch {
    return { error: "Malformed option data." };
  }
  // De-dupe values per option, strip blanks.
  payload = payload.map((o) => ({
    name: o.name?.trim() ?? "",
    values: [...new Set((o.values ?? []).map((v) => String(v).trim()).filter(Boolean))],
  }));
  const parsed = productOptionsSchema.safeParse(payload);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid options." };
  }
  const options = parsed.data;
  if (new Set(options.map((o) => o.name.toLowerCase())).size !== options.length) {
    return { error: "Each option type must have a unique name." };
  }

  // Rebuild options, keeping existing value ids where the (option, value) pair
  // is unchanged so variants that reference them survive.
  const current = await prisma.productOption.findMany({
    where: { productId },
    include: { values: true },
  });

  await prisma.$transaction(async (tx) => {
    // remove options no longer present
    const keepNames = new Set(options.map((o) => o.name.toLowerCase()));
    for (const opt of current) {
      if (!keepNames.has(opt.name.toLowerCase())) {
        await tx.productOption.delete({ where: { id: opt.id } });
      }
    }
    for (let i = 0; i < options.length; i++) {
      const def = options[i];
      const existing = current.find((o) => o.name.toLowerCase() === def.name.toLowerCase());
      const optionId = existing
        ? (await tx.productOption.update({ where: { id: existing.id }, data: { name: def.name, sortOrder: i } })).id
        : (await tx.productOption.create({ data: { productId, name: def.name, sortOrder: i } })).id;

      const existingValues = existing?.values ?? [];
      const keepValues = new Set(def.values.map((v) => v.toLowerCase()));
      for (const ev of existingValues) {
        if (!keepValues.has(ev.value.toLowerCase())) {
          await tx.productOptionValue.delete({ where: { id: ev.id } });
        }
      }
      for (let j = 0; j < def.values.length; j++) {
        const value = def.values[j];
        const ev = existingValues.find((v) => v.value.toLowerCase() === value.toLowerCase());
        const swatch =
          def.name.toLowerCase().includes("colour") || def.name.toLowerCase().includes("color")
            ? SWATCH_HINTS[value.toLowerCase().split(/[\s/]/)[0]] ?? null
            : null;
        if (ev) {
          await tx.productOptionValue.update({ where: { id: ev.id }, data: { value, sortOrder: j, swatchHex: swatch ?? ev.swatchHex } });
        } else {
          await tx.productOptionValue.create({ data: { optionId, value, sortOrder: j, swatchHex: swatch } });
        }
      }
    }
  });

  await regenerateVariants(productId);

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.product.updated",
    targetType: "product",
    targetId: productId,
    summary: `${admin.user.email} updated the options for “${product.name}”`,
    meta: { options: options.map((o) => `${o.name}: ${o.values.length}`) },
  });
  revalidateStorefront();
  return { ok: true, message: "Options saved and variants regenerated." };
}

export async function updateVariant(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("edit_products");
  const id = String(formData.get("id") ?? "");
  const variant = await prisma.variant.findUnique({
    where: { id },
    include: { product: { select: { id: true, name: true, variants: { select: { id: true } } } } },
  });
  if (!variant) return { error: "That variant no longer exists." };

  const parsed = variantUpdateSchema.safeParse({
    sku: String(formData.get("sku") ?? "").trim(),
    price: pesosToCentavos(formData.get("price")) ?? NaN,
    compareAtPrice: (() => {
      const c = pesosToCentavos(formData.get("compareAtPrice"));
      return c === null || Number.isNaN(c) ? null : c;
    })(),
    status: String(formData.get("status") ?? "ACTIVE"),
  });
  if (!parsed.success) {
    return { error: "Please fix the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error.issues) };
  }
  const data = parsed.data;

  if (data.sku !== variant.sku && (await skuInUse(data.sku, id))) {
    return { error: "That SKU is already in use.", fieldErrors: { sku: "Already in use" } };
  }

  try {
    await prisma.variant.update({
      where: { id },
      data: {
        sku: data.sku,
        price: data.price,
        compareAtPrice: data.compareAtPrice ?? null,
        status: data.status,
      },
    });
    await prisma.inventory.updateMany({ where: { variantId: id }, data: { sku: data.sku } });
  } catch (err) {
    console.error("[updateVariant]", err);
    return { error: "Could not save the variant." };
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.variant.updated",
    targetType: "variant",
    targetId: id,
    summary: `${admin.user.email} updated variant ${data.sku} of “${variant.product.name}”`,
    meta: { sku: data.sku, price: data.price, status: data.status },
  });
  revalidateStorefront();
  return { ok: true, message: "Variant saved." };
}

export async function deleteVariant(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("delete_products");
  const id = String(formData.get("id") ?? "");
  const variant = await prisma.variant.findUnique({
    where: { id },
    include: {
      _count: { select: { orderItems: true } },
      product: { select: { id: true, name: true, _count: { select: { variants: true } } } },
    },
  });
  if (!variant) return { error: "That variant no longer exists." };

  if (variant.product._count.variants <= 1) {
    return { error: "A product must keep at least one variant. Archive it instead." };
  }
  if (variant._count.orderItems > 0) {
    return { error: "This variant has order history and can’t be deleted. Archive it instead." };
  }

  await prisma.$transaction([
    prisma.inventory.deleteMany({ where: { variantId: id } }),
    prisma.variantOptionValue.deleteMany({ where: { variantId: id } }),
    prisma.variant.delete({ where: { id } }),
  ]);
  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.variant.deleted",
    targetType: "variant",
    targetId: id,
    summary: `${admin.user.email} deleted variant ${variant.sku} of “${variant.product.name}”`,
  });
  revalidateStorefront();
  return { ok: true, message: "Variant deleted." };
}

export async function addVariant(
  _prev: CatalogState,
  formData: FormData,
): Promise<CatalogState> {
  const admin = await requirePermission("create_products");
  const productId = String(formData.get("productId") ?? "");
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      name: true,
      slug: true,
      price: true,
      compareAtPrice: true,
      options: { select: { id: true, values: { select: { id: true, value: true } } } },
    },
  });
  if (!product) return { error: "That product no longer exists." };

  // One selected value per option.
  const chosen: string[] = [];
  for (const opt of product.options) {
    const picked = String(formData.get(`option_${opt.id}`) ?? "");
    if (!opt.values.some((v) => v.id === picked)) {
      return { error: "Choose a value for every option." };
    }
    chosen.push(picked);
  }

  // Reject a duplicate combination.
  if (chosen.length) {
    const existing = await prisma.variant.findMany({
      where: { productId },
      select: { id: true, optionValues: { select: { optionValueId: true } } },
    });
    const key = [...chosen].sort().join("|");
    if (existing.some((v) => [...v.optionValues.map((o) => o.optionValueId)].sort().join("|") === key)) {
      return { error: "A variant with that combination already exists." };
    }
  }

  const label = product.options
    .map((o) => o.values.find((v) => v.id === formData.get(`option_${o.id}`))?.value)
    .filter(Boolean)
    .join("-");
  let sku = String(formData.get("sku") ?? "").trim();
  if (!sku) sku = await generateVariantSku(product.slug, label);
  else if (await skuInUse(sku)) return { error: "That SKU is already in use.", fieldErrors: { sku: "Already in use" } };

  const price = pesosToCentavos(formData.get("price")) ?? product.price;
  if (!Number.isInteger(price) || price < 0) return { error: "Enter a valid price." };

  const variant = await prisma.variant.create({
    data: { productId, sku, price, compareAtPrice: product.compareAtPrice, status: "ACTIVE", stock: 0 },
  });
  if (chosen.length) {
    await prisma.variantOptionValue.createMany({
      data: chosen.map((optionValueId) => ({ variantId: variant.id, optionValueId })),
    });
  }
  await prisma.inventory.create({
    data: { variantId: variant.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "catalog.variant.created",
    targetType: "variant",
    targetId: variant.id,
    summary: `${admin.user.email} added variant ${sku} to “${product.name}”`,
    meta: { sku, price },
  });
  revalidateStorefront();
  return { ok: true, message: "Variant added." };
}
