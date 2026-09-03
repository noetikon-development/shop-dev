import "server-only";
import { prisma } from "@/lib/prisma";
import { generateVariantSku } from "@/lib/admin/catalog";
import { ensureFirstPartyOffer } from "@/lib/admin/offer-sync";

/**
 * Keeps a product's Variant rows in sync with its ProductOption / value
 * definitions — the cartesian product of the option values, one variant each.
 * A product with no options keeps exactly one "default" variant.
 *
 * Integrity rules:
 *   - a product always has ≥ 1 variant
 *   - a variant that has order history is NEVER deleted — it is archived instead
 *   - existing SKUs / prices are preserved wherever a combo still matches, and
 *     re-homed onto a new combo rather than deleted where possible
 */

const keyOf = (ids: string[]) => [...ids].sort().join("|");

export async function regenerateVariants(productId: string): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      slug: true,
      status: true,
      price: true,
      compareAtPrice: true,
      costPrice: true,
      options: {
        orderBy: { sortOrder: "asc" },
        select: { id: true, values: { orderBy: { sortOrder: "asc" }, select: { id: true } } },
      },
      variants: {
        select: {
          id: true,
          sku: true,
          price: true,
          compareAtPrice: true,
          status: true,
          optionValues: { select: { optionValueId: true } },
          _count: { select: { orderItems: true } },
        },
      },
    },
  });
  if (!product) return;

  // Target combos: cartesian product of one value id from each option.
  let combos: string[][] = [[]];
  for (const opt of product.options) {
    if (opt.values.length === 0) continue;
    combos = combos.flatMap((c) => opt.values.map((v) => [...c, v.id]));
  }
  const targetKeys = new Set(combos.map(keyOf));

  const existing = product.variants.map((v) => ({
    ...v,
    key: keyOf(v.optionValues.map((ov) => ov.optionValueId)),
    hasOrders: v._count.orderItems > 0,
  }));
  const matchedKeys = new Set(existing.map((v) => v.key).filter((k) => targetKeys.has(k)));

  const unmatchedExisting = existing.filter((v) => !targetKeys.has(v.key));
  const missingCombos = combos.filter((c) => !matchedKeys.has(keyOf(c)));

  // 1. Re-home an unmatched, order-free variant onto a missing combo (keeps SKU).
  const rehomable = unmatchedExisting.filter((v) => !v.hasOrders);
  const toDelete: typeof unmatchedExisting = [];
  const toArchive = unmatchedExisting.filter((v) => v.hasOrders && v.status !== "ARCHIVED");

  let ri = 0;
  for (const combo of missingCombos) {
    const reuse = rehomable[ri++];
    if (reuse) {
      await prisma.variantOptionValue.deleteMany({ where: { variantId: reuse.id } });
      if (combo.length) {
        await prisma.variantOptionValue.createMany({
          data: combo.map((optionValueId) => ({ variantId: reuse.id, optionValueId })),
        });
      }
      if (reuse.status === "ARCHIVED") {
        await prisma.variant.update({ where: { id: reuse.id }, data: { status: "ACTIVE" } });
      }
    } else {
      const hintParts = await optionValueLabels(combo);
      const sku = await generateVariantSku(product.slug, hintParts.join("-"));
      const variant = await prisma.variant.create({
        data: {
          productId: product.id,
          sku,
          price: product.price,
          compareAtPrice: product.compareAtPrice,
          status: "ACTIVE",
          stock: 0,
        },
      });
      if (combo.length) {
        await prisma.variantOptionValue.createMany({
          data: combo.map((optionValueId) => ({ variantId: variant.id, optionValueId })),
        });
      }
      await prisma.inventory.upsert({
        where: { variantId: variant.id },
        update: {},
        create: { variantId: variant.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 },
      });
      // Phase 9D-A: a regenerated variant needs its Axiaro FIRST_PARTY offer so
      // the storefront card price resolves.
      await ensureFirstPartyOffer(
        { id: variant.id, sku, price: product.price, compareAtPrice: product.compareAtPrice },
        { productStatus: product.status, costPrice: product.costPrice },
      );
    }
  }

  // 2. Leftover unmatched, order-free variants that weren't re-homed → delete.
  for (const v of rehomable.slice(ri)) toDelete.push(v);
  for (const v of toDelete) {
    await prisma.inventory.deleteMany({ where: { variantId: v.id } });
    await prisma.variantOptionValue.deleteMany({ where: { variantId: v.id } });
    await prisma.variant.delete({ where: { id: v.id } });
  }

  // 3. Order-bearing variants that no longer match → archive (never delete).
  for (const v of toArchive) {
    await prisma.variant.update({ where: { id: v.id }, data: { status: "ARCHIVED" } });
  }

  // 4. Safety net: a product must have at least one variant.
  const remaining = await prisma.variant.count({ where: { productId: product.id } });
  if (remaining === 0) {
    const sku = await generateVariantSku(product.slug);
    const variant = await prisma.variant.create({
      data: { productId: product.id, sku, price: product.price, compareAtPrice: product.compareAtPrice, status: "ACTIVE", stock: 0 },
    });
    await prisma.inventory.create({
      data: { variantId: variant.id, sku, quantity: 0, reserved: 0, reorderPoint: 3 },
    });
    await ensureFirstPartyOffer(
      { id: variant.id, sku, price: product.price, compareAtPrice: product.compareAtPrice },
      { productStatus: product.status, costPrice: product.costPrice },
    );
  }
}

async function optionValueLabels(valueIds: string[]): Promise<string[]> {
  if (valueIds.length === 0) return [];
  const rows = await prisma.productOptionValue.findMany({
    where: { id: { in: valueIds } },
    select: { value: true },
  });
  return rows.map((r) => r.value);
}
