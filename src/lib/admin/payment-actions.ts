"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { getPaymentsConfig } from "@/lib/payments/config";
import { getCheckoutSession, PaymongoNotConfiguredError } from "@/lib/payments/paymongo";
import {
  confirmCodPaymentReceived,
  type ConfirmCodPaymentInput,
  type ConfirmCodPaymentResult,
} from "@/lib/admin/payments";

/**
 * Admin payment actions (Step 21 P4).
 *
 * Phase 4-A: the only PayMongo action is reconciliation, and it is DORMANT —
 * with no PayMongo key configured, `getCheckoutSession` throws
 * `PaymongoNotConfiguredError` and the action returns a friendly message.
 *
 * For an ONLINE order, `Order.paymentStatus` / `Order.status` are only ever
 * advanced by the signature-verified webhook (src/lib/payments/webhook.ts).
 * Reconciliation re-reads the provider's own record — it never trusts an admin's
 * assertion that a payment happened.
 *
 * 9F-43B adds ONE scoped, heavily-guarded exception for CASH-ON-DELIVERY:
 * `confirmCodPaymentAction` lets an authorized `manage_payments` admin record
 * that Axiaro has RECEIVED the remitted COD cash for a DELIVERED COD order,
 * moving `paymentStatus` PENDING/UNPAID → PAID. It creates NO Payment /
 * PaymentRefund / WebhookEvent row (COD never touches the PayMongo ledger), only
 * an `OrderEvent` and an `AdminAuditLog` row. It never runs automatically —
 * delivery is not payment; a human confirms remittance. There is deliberately no
 * reverse / un-confirm action and no partial / operator-entered amount.
 */

export type PaymentActionState = { ok: boolean; message?: string; error?: string };

const reconcileSchema = z.object({ paymentId: z.string().min(1).max(64) });

export async function reconcilePaymentAction(input: unknown): Promise<PaymentActionState> {
  const admin = await requirePermission("manage_payments");
  const parsed = reconcileSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const payment = await prisma.payment.findUnique({
    where: { id: parsed.data.paymentId },
    select: {
      id: true,
      providerObject: true,
      providerId: true,
      status: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });
  if (!payment) return { ok: false, error: "Payment not found." };

  const config = await getPaymentsConfig();
  if (!config.onlinePaymentEnabled) {
    return {
      ok: false,
      error: "Online payment is not enabled — there is nothing to reconcile with PayMongo.",
    };
  }

  try {
    // Read-only truth check against the provider. Any state transition that
    // results from this goes through the SAME webhook path, not a shortcut here.
    const remote = await getCheckoutSession(payment.providerId);
    await writeAudit({
      actorUserId: admin.user.id,
      action: "payment.reconcile_checked",
      targetType: "order",
      targetId: payment.order.id,
      summary: `${admin.user.email} re-checked payment ${payment.providerId} for order ${payment.order.orderNumber} with PayMongo`,
      meta: { paymentId: payment.id, localStatus: payment.status, hasRemote: Boolean(remote) },
    });
    revalidatePath("/admin/payments");
    revalidatePath(`/admin/orders/${payment.order.id}`);
    return {
      ok: true,
      message:
        "Checked with PayMongo. If the provider shows the payment as paid but our record does not, replay the webhook from the PayMongo dashboard — reconciliation never marks an order paid on its own.",
    };
  } catch (err) {
    if (err instanceof PaymongoNotConfiguredError) {
      return { ok: false, error: "PayMongo is not configured on this deployment." };
    }
    const detail = err instanceof Error ? err.message : "unknown error";
    return { ok: false, error: `Could not reach PayMongo: ${detail}` };
  }
}

// ---------------------------------------------------------------------------
// 9F-43B — COD cash collection confirmation
// ---------------------------------------------------------------------------

const confirmCodSchema = z.object({
  orderId: z.string().min(1).max(64),
  remittanceReference: z.string().max(200).optional().nullable(),
  note: z.string().max(4000).optional().nullable(),
});

/**
 * Record that Axiaro has received the remitted COD cash for a delivered
 * cash-on-delivery order: `paymentStatus` PENDING/UNPAID → PAID. This unlocks
 * the 9F-42B settlement-eligibility gate for the order's 3P SellerOrder.
 *
 * `manage_payments` only. Seller sessions authenticate through a separate
 * `requireSellerSession` and hold no admin RBAC permissions — they can never
 * reach this. The confirmed amount is ALWAYS `Order.grandTotal`; the operator
 * never enters an amount. All guards + the atomic transaction (status-guarded
 * `updateMany` + `OrderEvent{status:"PAID"}` + `AdminAuditLog`) live in the
 * `confirmCodPaymentReceived` core; NO Payment / PaymentRefund / WebhookEvent
 * row is ever created. There is deliberately no reverse / un-confirm action.
 */
export async function confirmCodPaymentAction(
  input: ConfirmCodPaymentInput,
): Promise<ConfirmCodPaymentResult> {
  const admin = await requirePermission("manage_payments");

  const parsed = confirmCodSchema.safeParse(input);
  if (!parsed.success) return { ok: false, code: "NOT_FOUND", error: "Invalid request." };

  const result = await confirmCodPaymentReceived(
    {
      orderId: parsed.data.orderId,
      remittanceReference: parsed.data.remittanceReference ?? null,
      note: parsed.data.note ?? null,
    },
    { userId: admin.user.id, email: admin.user.email },
  );

  if (result.ok && !result.alreadyConfirmed) {
    revalidatePath(`/admin/orders/${parsed.data.orderId}`);
    revalidatePath("/admin/orders");
    revalidatePath("/admin/settlements");
    revalidatePath("/seller/settlements");
    revalidatePath("/admin/audit");
  }
  return result;
}

export type ConfirmCodPaymentFormState = {
  ok?: boolean;
  error?: string;
  message?: string;
  alreadyConfirmed?: boolean;
};

const CONFIRM_COD_MESSAGES: Record<string, string> = {
  NOT_FOUND: "Order not found.",
  HAS_ONLINE_PAYMENT: "This order is paid online — its payment status is managed by the payment provider.",
  NOT_COD: "This is not a cash-on-delivery order.",
  NOT_DELIVERED: "The order must be delivered before COD payment can be confirmed.",
  CANCELLED: "This order is cancelled.",
  REFUNDED: "This order has been refunded.",
};

/** Form-action adapter for `usePersistentAction` on the admin order detail page. */
export async function confirmCodPaymentFormAction(
  _prev: ConfirmCodPaymentFormState,
  formData: FormData,
): Promise<ConfirmCodPaymentFormState> {
  const orderId = String(formData.get("orderId") ?? "");
  const remittanceReference = formData.get("remittanceReference");
  const note = formData.get("note");

  const res = await confirmCodPaymentAction({
    orderId,
    remittanceReference: typeof remittanceReference === "string" ? remittanceReference : null,
    note: typeof note === "string" ? note : null,
  });

  if (res.ok) {
    return {
      ok: true,
      alreadyConfirmed: res.alreadyConfirmed,
      message: res.alreadyConfirmed ? "This COD payment was already recorded." : "COD payment recorded.",
    };
  }
  return { ok: false, error: CONFIRM_COD_MESSAGES[res.code] ?? res.error };
}
