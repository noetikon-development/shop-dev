"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendReturnReceived } from "@/lib/email/notifications";
import {
  sellerReceiveReturn,
  type SellerReturnRepoError,
  type SellerReceiptLine,
} from "@/lib/marketplace/seller-return-repository";

/**
 * `/seller/returns` server actions (Phase 9F-3).
 *
 * The seller may ONLY confirm physical receipt (which advances the return
 * `APPROVED → RECEIVED`) and record per-line condition / restock quantity for
 * its own lines. Approve / reject / refund are admin-only and are NOT reachable
 * from here.
 *
 * This never touches `Order.status` / `OrderEvent` / the customer timeline /
 * `Inventory` / `InventoryAdjustment` / `Variant.stock` / any refund field, and
 * never revalidates the storefront. Restock is `restoreOfferStock(RETURN)` only.
 */

export type SellerReturnActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  message?: string;
};

function fromRepoError(e: SellerReturnRepoError): SellerReturnActionState {
  return { error: e.error };
}

const receiptSchema = z.object({
  returnId: z.string().min(1),
  lines: z
    .array(
      z.object({
        returnItemId: z.string().min(1),
        receivedQuantity: z.coerce.number().int().min(0).max(100_000),
        restockQuantity: z.coerce.number().int().min(0).max(100_000),
        condition: z.enum(["RESELLABLE", "OPENED", "DAMAGED"]),
      }),
    )
    .min(1),
});

/**
 * Parse a flat form (`returnId`, and per-line `recv:<id>` / `restock:<id>` /
 * `condition:<id>`) into the schema shape.
 */
function parseReceiptForm(formData: FormData): unknown {
  const returnId = String(formData.get("returnId") ?? "");
  const ids = new Set<string>();
  for (const key of formData.keys()) {
    const m = key.match(/^(?:recv|restock|condition):(.+)$/);
    if (m) ids.add(m[1]);
  }
  const lines = [...ids].map((id) => ({
    returnItemId: id,
    receivedQuantity: formData.get(`recv:${id}`) ?? 0,
    restockQuantity: formData.get(`restock:${id}`) ?? 0,
    condition: formData.get(`condition:${id}`) ?? "RESELLABLE",
  }));
  return { returnId, lines };
}

export async function sellerReceiveReturnAction(
  _prev: SellerReturnActionState,
  formData: FormData,
): Promise<SellerReturnActionState> {
  const { ctx } = await requireSellerSessionPermission("manage_seller_returns");

  const parsed = receiptSchema.safeParse(parseReceiptForm(formData));
  if (!parsed.success) {
    return { error: "Please record a received and restock quantity, and a condition, for every line." };
  }

  const res = await sellerReceiveReturn(
    ctx,
    parsed.data.returnId,
    parsed.data.lines as SellerReceiptLine[],
  );
  if (!res.ok) return fromRepoError(res);

  // Traceable record of who received the return (generic audit log).
  await writeAudit({
    actorUserId: ctx.userId,
    action: "seller.return.received",
    targetType: "return",
    targetId: parsed.data.returnId,
    summary:
      `seller ${ctx.sellerName} confirmed receipt of return ${res.returnNumber} ` +
      `(order ${res.orderNumber}); restocked ${res.restockedUnits} unit(s) across ${res.restocked.length} line(s)`,
    meta: {
      sellerId: ctx.sellerId,
      returnNumber: res.returnNumber,
      orderNumber: res.orderNumber,
      from: "APPROVED",
      to: "RECEIVED",
      restocked: res.restocked,
      lines: parsed.data.lines.map((l) => ({
        returnItemId: l.returnItemId,
        receivedQuantity: l.receivedQuantity,
        restockQuantity: l.restockQuantity,
        condition: l.condition,
      })),
    },
  });

  // Same customer-facing email the admin RECEIVED transition sends — the
  // customer return flow is unchanged.
  scheduleEmail(() => sendReturnReceived(parsed.data.returnId));

  revalidatePath(`/seller/returns/${parsed.data.returnId}`);
  revalidatePath("/seller/returns");
  revalidatePath("/seller");
  // keep the admin returns views fresh too (status changed)
  revalidatePath("/admin/returns");
  revalidatePath(`/admin/returns/${parsed.data.returnId}`);

  return {
    ok: true,
    message:
      res.restockedUnits > 0
        ? `Receipt confirmed. ${res.restockedUnits} unit(s) returned to your stock.`
        : "Receipt confirmed.",
  };
}
