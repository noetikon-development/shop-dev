"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendSellerSettlementRecorded } from "@/lib/email/notifications";
import { recordSettlement } from "@/lib/admin/settlements";

/**
 * Admin "record settlement" server action (Phase 9F-8e).
 *
 * Bookkeeping-only: an authorized admin (`manage_payments`) records that a
 * payment was made to a THIRD_PARTY seller outside the system. All amounts are
 * recomputed server-side in `recordSettlement` — the form only supplies the
 * seller, the payment date, and the free-text reference / method / note.
 */

export type RecordSettlementState = { ok?: boolean; error?: string; message?: string; settlementId?: string };

const schema = z.object({
  sellerId: z.string().min(1).max(64),
  paidAt: z.string().min(1).max(40),
  paymentReference: z.string().trim().max(200).optional().or(z.literal("")),
  paymentMethod: z.string().trim().max(120).optional().or(z.literal("")),
  note: z.string().trim().max(2000).optional().or(z.literal("")),
});

export async function recordSettlementAction(
  _prev: RecordSettlementState,
  formData: FormData,
): Promise<RecordSettlementState> {
  const admin = await requirePermission("manage_payments");

  const parsed = schema.safeParse({
    sellerId: formData.get("sellerId"),
    paidAt: formData.get("paidAt"),
    paymentReference: formData.get("paymentReference") ?? "",
    paymentMethod: formData.get("paymentMethod") ?? "",
    note: formData.get("note") ?? "",
  });
  if (!parsed.success) return { error: "Please check the highlighted fields." };

  const paidAt = new Date(parsed.data.paidAt);
  if (Number.isNaN(paidAt.getTime())) return { error: "Enter a valid payment date." };

  const res = await recordSettlement({
    sellerId: parsed.data.sellerId,
    paidAt,
    paymentReference: parsed.data.paymentReference || null,
    paymentMethod: parsed.data.paymentMethod || null,
    note: parsed.data.note || null,
    actorUserId: admin.user.id,
  });
  if (!res.ok) return { error: res.error };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "seller.settlement.recorded",
    targetType: "seller_settlement",
    targetId: res.settlementId,
    summary:
      `${admin.user.email} recorded a bookkeeping settlement for seller ${parsed.data.sellerId} ` +
      `(net ${res.netAmount} centavos across ${res.orderCount} order(s), ${res.clawbackCount} clawback(s))`,
    meta: {
      sellerId: parsed.data.sellerId,
      settlementId: res.settlementId,
      netAmount: res.netAmount,
      orderCount: res.orderCount,
      clawbackCount: res.clawbackCount,
      paidAt: paidAt.toISOString(),
      bookkeepingOnly: true,
    },
  });

  revalidatePath("/admin/settlements");
  revalidatePath(`/admin/settlements/${res.settlementId}`);
  revalidatePath("/admin/seller-orders");
  revalidatePath("/seller/settlements");
  revalidatePath("/admin/audit");

  // 9F-20 — notify the seller their settlement was recorded. Post-commit,
  // non-blocking; bookkeeping-only copy. Key SETTLEMENT_RECORDED:<settlementId>
  // dedupes, and 9F-18 raises the ops failure alert if the send fails.
  scheduleEmail(() => sendSellerSettlementRecorded(res.settlementId));

  return { ok: true, message: "Settlement recorded.", settlementId: res.settlementId };
}
