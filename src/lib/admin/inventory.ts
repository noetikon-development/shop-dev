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
// Adjustment history — UNION of the two ledgers (Phase 9E-3D-6, D-1)
//
//   ledger "legacy"  — `InventoryAdjustment`, the FROZEN pre-retirement archive
//                      (SALE / CANCELLATION / RETURN before 9E-3D-5, admin
//                      adjustments before 9E-3D-6). Carries the `actor` relation.
//   ledger "current" — `OfferAdjustment` for FIRST_PARTY offers, excluding the
//                      `MIGRATION_OPENING` backfill rows. The operational ledger
//                      since the retirement boundary (SALE 9E-3C-2, CANCELLATION
//                      / RETURN 9E-3D-1, admin 9E-3D-6). Actor resolved by id.
//
// Old rows are never rewritten; the two histories keep separate semantics. The
// merge is in-memory — both ledgers are small (2 legacy rows + a handful of
// operational rows for this catalogue), same pattern as `listInventory`.
// ---------------------------------------------------------------------------

const OPENING_REASON = "MIGRATION_OPENING";

export type HistoryRow = {
  id: string;
  ledger: "legacy" | "current";
  createdAt: Date;
  productId: string;
  productName: string;
  optionLabel: string;
  sku: string;
  previousQuantity: number;
  delta: number;
  newQuantity: number;
  reason: string;
  note: string | null;
  actor: string;
};

function optionLabelOf(
  optionValues: { optionValue: { value: string; option: { name: string } } }[],
): string {
  return (
    optionValues
      .map((ov) => `${ov.optionValue.option.name}: ${ov.optionValue.value}`)
      .join(" · ") || "Default"
  );
}

export async function listInventoryHistory(filters: {
  q?: string;
  reason?: string;
  page?: number;
}) {
  const page = Math.max(1, filters.page ?? 1);
  const q = filters.q?.trim();
  const reason = filters.reason;

  // --- legacy ledger: InventoryAdjustment ---------------------------------
  const legacyWhere: Record<string, unknown> = {};
  const legacyAND: Record<string, unknown>[] = [];
  if (q) {
    legacyAND.push({
      OR: [
        { inventory: { sku: { contains: q, mode: "insensitive" } } },
        { inventory: { variant: { product: { name: { contains: q, mode: "insensitive" } } } } },
      ],
    });
  }
  if (reason) legacyAND.push({ reason });
  if (legacyAND.length) legacyWhere.AND = legacyAND;

  // --- current ledger: OfferAdjustment (FIRST_PARTY, non-opening) ---------
  const currentWhere: Record<string, unknown> = {
    reason: reason ?? { not: OPENING_REASON },
    offerInventory: { offer: { ...FIRST_PARTY_OFFER_FILTER } },
  };
  if (reason === OPENING_REASON) {
    // never surface backfill rows, even if explicitly filtered
    currentWhere.id = "__never__";
  }
  if (q) {
    currentWhere.offerInventory = {
      offer: {
        ...FIRST_PARTY_OFFER_FILTER,
        variant: {
          OR: [
            { sku: { contains: q, mode: "insensitive" } },
            { product: { name: { contains: q, mode: "insensitive" } } },
          ],
        },
      },
    };
  }

  const [legacyRows, currentRows] = await Promise.all([
    prisma.inventoryAdjustment.findMany({
      where: legacyWhere,
      orderBy: { createdAt: "desc" },
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
    prisma.offerAdjustment.findMany({
      where: currentWhere,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        previousQuantity: true,
        delta: true,
        newQuantity: true,
        reason: true,
        note: true,
        createdAt: true,
        actorUserId: true,
        offerInventory: {
          select: {
            offer: {
              select: {
                variant: {
                  select: {
                    sku: true,
                    product: { select: { id: true, name: true } },
                    optionValues: {
                      select: { optionValue: { select: { value: true, option: { select: { name: true } } } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }),
  ]);

  // resolve OfferAdjustment actor names in one query
  const actorIds = [...new Set(currentRows.map((r) => r.actorUserId).filter((v): v is string => !!v))];
  const actors = actorIds.length
    ? new Map(
        (
          await prisma.user.findMany({
            where: { id: { in: actorIds } },
            select: { id: true, name: true, email: true },
          })
        ).map((u) => [u.id, u.name ?? u.email]),
      )
    : new Map<string, string>();

  const merged: HistoryRow[] = [
    ...legacyRows.map((r) => ({
      id: r.id,
      ledger: "legacy" as const,
      createdAt: r.createdAt,
      productId: r.inventory.variant.product.id,
      productName: r.inventory.variant.product.name,
      optionLabel: optionLabelOf(r.inventory.variant.optionValues),
      sku: r.inventory.sku,
      previousQuantity: r.previousQuantity,
      delta: r.delta,
      newQuantity: r.newQuantity,
      reason: r.reason,
      note: r.note,
      actor: r.actor?.name ?? r.actor?.email ?? "system",
    })),
    ...currentRows.map((r) => {
      const v = r.offerInventory.offer.variant;
      return {
        id: r.id,
        ledger: "current" as const,
        createdAt: r.createdAt,
        productId: v.product.id,
        productName: v.product.name,
        optionLabel: optionLabelOf(v.optionValues),
        sku: v.sku,
        previousQuantity: r.previousQuantity,
        delta: r.delta,
        newQuantity: r.newQuantity,
        reason: r.reason,
        note: r.note,
        actor: (r.actorUserId && actors.get(r.actorUserId)) ?? "system",
      };
    }),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const total = merged.length;
  const start = (page - 1) * HISTORY_PAGE_SIZE;
  return {
    rows: merged.slice(start, start + HISTORY_PAGE_SIZE),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE)),
  };
}

/** Distinct reasons across both ledgers — for the filter dropdown. */
export async function historyReasons(): Promise<string[]> {
  const [legacy, current] = await Promise.all([
    prisma.inventoryAdjustment.findMany({ distinct: ["reason"], select: { reason: true } }),
    prisma.offerAdjustment.findMany({
      where: { reason: { not: OPENING_REASON }, offerInventory: { offer: { ...FIRST_PARTY_OFFER_FILTER } } },
      distinct: ["reason"],
      select: { reason: true },
    }),
  ]);
  return [...new Set([...legacy, ...current].map((r) => r.reason))].sort();
}
