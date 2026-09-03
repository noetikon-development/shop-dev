import "server-only";
import { prisma } from "@/lib/prisma";
import { stockStatus, type StockStatus } from "@/lib/inventory-status";
import { FIRST_PARTY_OFFER_FILTER } from "@/lib/admin/first-party-inventory";

/**
 * Admin read layer for inventory. Uncached — admins see live numbers.
 *
 * Phase 9E-3D-2: current stock state (list + detail) is sourced from the
 * Axiaro FIRST_PARTY `OfferInventory` — the operational authority. `Inventory`
 * remains a synchronized mirror. The adjustment HISTORY below deliberately
 * stays on `InventoryAdjustment`: every 1P mutation still writes a mirror row
 * (checkout / cancel / return / admin), so that history is complete, and it
 * carries the `actor` relation `OfferAdjustment` lacks. Switching it would be
 * a semantic change, not an authority change — out of scope for this phase.
 */

export const INVENTORY_PAGE_SIZE = 25;
export const HISTORY_PAGE_SIZE = 30;

// ---------------------------------------------------------------------------
// Inventory list
// ---------------------------------------------------------------------------

export type InventoryRow = {
  inventoryId: string;
  variantId: string;
  sku: string;
  productId: string;
  productName: string;
  productStatus: string;
  variantStatus: string;
  optionLabel: string;
  quantity: number;
  reserved: number;
  available: number;
  reorderPoint: number;
  status: StockStatus;
  updatedAt: Date;
};

/**
 * One Axiaro FIRST_PARTY `OfferInventory` row joined to its variant. `sku` is
 * read from `Variant.sku` (the catalog identifier) rather than either mirror's
 * copy. `inventoryId` carries the OfferInventory row id — it is only a stable
 * React key downstream; every mutation is addressed by `variantId`.
 */
type OfferInventoryRow = {
  id: string;
  quantity: number;
  reserved: number;
  reorderPoint: number;
  updatedAt: Date;
  offer: {
    variant: {
      id: string;
      sku: string;
      status: string;
      product: { id: string; name: string; status: string };
      optionValues: { optionValue: { value: string; option: { name: string } } }[];
    };
  };
};

function offerInventorySelect(withSlug: boolean) {
  return {
    id: true,
    quantity: true,
    reserved: true,
    reorderPoint: true,
    updatedAt: true,
    offer: {
      select: {
        variant: {
          select: {
            id: true,
            sku: true,
            status: true,
            product: {
              select: withSlug
                ? { id: true, name: true, slug: true, status: true }
                : { id: true, name: true, status: true },
            },
            optionValues: {
              select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
            },
          },
        },
      },
    },
  } as const;
}

function toRow(oi: OfferInventoryRow): InventoryRow {
  const v = oi.offer.variant;
  const available = Math.max(0, oi.quantity - oi.reserved);
  return {
    inventoryId: oi.id,
    variantId: v.id,
    sku: v.sku,
    productId: v.product.id,
    productName: v.product.name,
    productStatus: v.product.status,
    variantStatus: v.status,
    optionLabel:
      v.optionValues
        .map((ov) => `${ov.optionValue.option.name}: ${ov.optionValue.value}`)
        .join(" · ") || "Default",
    quantity: oi.quantity,
    reserved: oi.reserved,
    available,
    reorderPoint: oi.reorderPoint,
    status: stockStatus(oi.quantity, oi.reserved, oi.reorderPoint),
    updatedAt: oi.updatedAt,
  };
}

export async function listInventory(filters: { q?: string; status?: string; page?: number }) {
  const page = Math.max(1, filters.page ?? 1);

  // Source of truth = the Axiaro FIRST_PARTY OfferInventory. Status is derived,
  // so it can't be a SQL WHERE clause — the catalog is a few hundred variants,
  // so load the (search-)filtered set and filter/paginate the status in memory.
  const offerWhere: Record<string, unknown> = { ...FIRST_PARTY_OFFER_FILTER };
  if (filters.q?.trim()) {
    // Text search targets Variant.sku (the catalog identifier) and product name.
    const q = filters.q.trim();
    offerWhere.variant = {
      OR: [
        { sku: { contains: q, mode: "insensitive" } },
        { product: { name: { contains: q, mode: "insensitive" } } },
      ],
    };
  }
  const all = await prisma.offerInventory.findMany({
    where: { offer: offerWhere },
    orderBy: [
      { offer: { variant: { product: { name: "asc" } } } },
      { offer: { variant: { sku: "asc" } } },
    ],
    select: offerInventorySelect(false),
  });

  const mapped = all.map(toRow);

  // Summary always reflects the whole catalog (only the text search narrows it),
  // never the status facet — so the three counts stay a stable overview while
  // the user filters the table.
  const summary = {
    inStock: mapped.filter((r) => r.status === "IN_STOCK").length,
    lowStock: mapped.filter((r) => r.status === "LOW_STOCK").length,
    outOfStock: mapped.filter((r) => r.status === "OUT_OF_STOCK").length,
  };

  let rows = mapped;
  if (filters.status && ["IN_STOCK", "LOW_STOCK", "OUT_OF_STOCK"].includes(filters.status)) {
    rows = rows.filter((r) => r.status === filters.status);
  }

  const total = rows.length;
  const start = (page - 1) * INVENTORY_PAGE_SIZE;
  return {
    rows: rows.slice(start, start + INVENTORY_PAGE_SIZE),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / INVENTORY_PAGE_SIZE)),
    summary,
  };
}

export async function getInventoryDetail(variantId: string) {
  const oi = await prisma.offerInventory.findFirst({
    where: { offer: { variantId, ...FIRST_PARTY_OFFER_FILTER } },
    select: offerInventorySelect(true),
  });
  if (!oi) return null;
  const product = oi.offer.variant.product as { slug: string };
  return { ...toRow(oi), productSlug: product.slug };
}

// ---------------------------------------------------------------------------
// Adjustment history
// ---------------------------------------------------------------------------

export async function listInventoryHistory(filters: {
  q?: string;
  reason?: string;
  page?: number;
}) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Record<string, unknown> = {};
  const AND: Record<string, unknown>[] = [];
  if (filters.q) {
    const q = filters.q.trim();
    AND.push({
      OR: [
        { inventory: { sku: { contains: q, mode: "insensitive" } } },
        { inventory: { variant: { product: { name: { contains: q, mode: "insensitive" } } } } },
      ],
    });
  }
  if (filters.reason) AND.push({ reason: filters.reason });
  if (AND.length) where.AND = AND;

  const [rows, total] = await Promise.all([
    prisma.inventoryAdjustment.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * HISTORY_PAGE_SIZE,
      take: HISTORY_PAGE_SIZE,
      select: {
        id: true,
        previousQuantity: true,
        delta: true,
        newQuantity: true,
        reason: true,
        note: true,
        createdAt: true,
        actor: { select: { email: true, name: true } },
        inventory: {
          select: {
            sku: true,
            variant: {
              select: {
                product: { select: { id: true, name: true } },
                optionValues: {
                  select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
                },
              },
            },
          },
        },
      },
    }),
    prisma.inventoryAdjustment.count({ where }),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      productId: r.inventory.variant.product.id,
      productName: r.inventory.variant.product.name,
      optionLabel:
        r.inventory.variant.optionValues
          .map((ov) => `${ov.optionValue.option.name}: ${ov.optionValue.value}`)
          .join(" · ") || "Default",
      sku: r.inventory.sku,
      previousQuantity: r.previousQuantity,
      delta: r.delta,
      newQuantity: r.newQuantity,
      reason: r.reason,
      note: r.note,
      actor: r.actor?.name ?? r.actor?.email ?? "system",
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
  };
}

/** Distinct reasons present in the history — for the filter dropdown. */
export async function historyReasons(): Promise<string[]> {
  const rows = await prisma.inventoryAdjustment.findMany({
    distinct: ["reason"],
    select: { reason: true },
    orderBy: { reason: "asc" },
  });
  return rows.map((r) => r.reason);
}
