import "server-only";
import { prisma } from "@/lib/prisma";
import { stockStatus, type StockStatus } from "@/lib/inventory-status";

/**
 * Admin read layer for inventory. Uncached — admins see live numbers.
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

function toRow(inv: {
  id: string;
  sku: string;
  quantity: number;
  reserved: number;
  reorderPoint: number;
  updatedAt: Date;
  variant: {
    id: string;
    status: string;
    product: { id: string; name: string; status: string };
    optionValues: { optionValue: { value: string; option: { name: string } } }[];
  };
}): InventoryRow {
  const available = Math.max(0, inv.quantity - inv.reserved);
  return {
    inventoryId: inv.id,
    variantId: inv.variant.id,
    sku: inv.sku,
    productId: inv.variant.product.id,
    productName: inv.variant.product.name,
    productStatus: inv.variant.product.status,
    variantStatus: inv.variant.status,
    optionLabel:
      inv.variant.optionValues
        .map((ov) => `${ov.optionValue.option.name}: ${ov.optionValue.value}`)
        .join(" · ") || "Default",
    quantity: inv.quantity,
    reserved: inv.reserved,
    available,
    reorderPoint: inv.reorderPoint,
    status: stockStatus(inv.quantity, inv.reserved, inv.reorderPoint),
    updatedAt: inv.updatedAt,
  };
}

export async function listInventory(filters: { q?: string; status?: string; page?: number }) {
  const page = Math.max(1, filters.page ?? 1);
  const where: Record<string, unknown> = {};
  if (filters.q) {
    const q = filters.q.trim();
    where.OR = [
      { sku: { contains: q, mode: "insensitive" } },
      { variant: { product: { name: { contains: q, mode: "insensitive" } } } },
    ];
  }

  // Status is derived, so it can't be a SQL WHERE clause. The catalog is small
  // (a few hundred variants); load the (search-)filtered set and filter/paginate
  // the status in memory.
  const all = await prisma.inventory.findMany({
    where,
    orderBy: [{ variant: { product: { name: "asc" } } }, { sku: "asc" }],
    select: {
      id: true,
      sku: true,
      quantity: true,
      reserved: true,
      reorderPoint: true,
      updatedAt: true,
      variant: {
        select: {
          id: true,
          status: true,
          product: { select: { id: true, name: true, status: true } },
          optionValues: {
            select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
          },
        },
      },
    },
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
  const inv = await prisma.inventory.findUnique({
    where: { variantId },
    select: {
      id: true,
      sku: true,
      quantity: true,
      reserved: true,
      reorderPoint: true,
      updatedAt: true,
      variant: {
        select: {
          id: true,
          status: true,
          product: { select: { id: true, name: true, slug: true, status: true } },
          optionValues: {
            select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
          },
        },
      },
    },
  });
  if (!inv) return null;
  return { ...toRow(inv), productSlug: inv.variant.product.slug };
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
