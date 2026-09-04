import "server-only";
import {
  listSellerReturns,
  countSellerReturns,
  getSellerReturnForSeller,
} from "@/lib/marketplace/seller-return-repository";
import { canTransitionReturn } from "@/lib/returns/status";
import type { SellerContext } from "@/lib/marketplace/types";

/** Read models for `/seller/returns`. All seller-scoped via the repository. */

const PAGE_SIZE = 20;

function safeAddress(json: string | null): Record<string, string> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" ? (v as Record<string, string>) : null;
  } catch {
    return null;
  }
}

export type SellerReturnRow = {
  id: string;
  returnNumber: string;
  status: string;
  reason: string;
  orderNumber: string;
  createdAt: Date;
  unitCount: number;
  lineCount: number;
};

export async function listSellerReturnsPage(
  ctx: SellerContext,
  opts: { status?: string; q?: string; page?: number } = {},
) {
  const page = Math.max(1, opts.page ?? 1);
  const filters = {
    status: opts.status && opts.status !== "ALL" ? opts.status : undefined,
    q: opts.q?.trim() || undefined,
  };
  const [rows, total] = await Promise.all([
    listSellerReturns(ctx, { ...filters, skip: (page - 1) * PAGE_SIZE, take: PAGE_SIZE }),
    countSellerReturns(ctx, filters),
  ]);
  return {
    rows: rows.map<SellerReturnRow>((r) => ({
      id: r.id,
      returnNumber: r.returnNumber,
      status: r.status,
      reason: r.reason,
      orderNumber: r.order.orderNumber,
      createdAt: r.createdAt,
      unitCount: r.items.reduce((n, i) => n + i.quantity, 0),
      lineCount: r.items.length,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

export async function countOpenSellerReturns(ctx: SellerContext): Promise<number> {
  return countSellerReturns(ctx, { status: "APPROVED" });
}

export type SellerReturnLineView = {
  id: string;
  name: string;
  variantLabel: string | null;
  sku: string | null;
  unitPrice: number;
  quantity: number;
  restockQuantity: number;
  condition: string | null;
  offerBound: boolean;
};

export type SellerReturnDetailView = {
  id: string;
  returnNumber: string;
  status: string;
  reason: string;
  customerNote: string | null;
  resolutionNote: string | null;
  createdAt: Date;
  updatedAt: Date;
  restockedAt: Date | null;
  orderNumber: string;
  orderStatus: string;
  placedAt: Date;
  deliveredAt: Date | null;
  ship: { recipient: string; phone: string | null; lines: string[] } | null;
  lines: SellerReturnLineView[];
  /** the seller can run the receipt step only from APPROVED */
  canReceive: boolean;
};

export async function getSellerReturnDetail(
  ctx: SellerContext,
  returnId: string,
): Promise<SellerReturnDetailView | null> {
  const r = await getSellerReturnForSeller(ctx, returnId);
  if (!r) return null;

  const addr = safeAddress(r.order.shippingAddress);
  const ship = addr
    ? {
        recipient:
          [addr.firstName, addr.lastName].filter(Boolean).join(" ") || addr.recipient || "—",
        phone: addr.phone || null,
        lines: [
          addr.company || "",
          addr.line1 || "",
          addr.line2 || "",
          [addr.barangay, addr.city].filter(Boolean).join(", "),
          [addr.province, addr.postalCode].filter(Boolean).join(" "),
          addr.region || "",
          addr.country || "",
        ].filter(Boolean),
      }
    : null;

  return {
    id: r.id,
    returnNumber: r.returnNumber,
    status: r.status,
    reason: r.reason,
    customerNote: r.customerNote,
    resolutionNote: r.resolutionNote,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    restockedAt: r.restockedAt,
    orderNumber: r.order.orderNumber,
    orderStatus: r.order.status,
    placedAt: r.order.placedAt,
    deliveredAt: r.order.deliveredAt,
    ship,
    lines: r.items.map((it) => ({
      id: it.id,
      name: it.name,
      variantLabel: it.variantLabel,
      sku: it.sku,
      unitPrice: it.unitPrice,
      quantity: it.quantity,
      restockQuantity: it.restockQuantity,
      condition: it.condition,
      offerBound: Boolean(it.orderItem.offerId),
    })),
    canReceive: canTransitionReturn(r.status, "RECEIVED"),
  };
}
