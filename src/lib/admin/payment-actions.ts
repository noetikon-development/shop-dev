"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { getPaymentsConfig } from "@/lib/payments/config";
import { getCheckoutSession, PaymongoNotConfiguredError } from "@/lib/payments/paymongo";

/**
 * Admin payment actions (Step 21 P4).
 *
 * Phase 4-A: the only action is reconciliation, and it is DORMANT — with no
 * PayMongo key configured, `getCheckoutSession` throws
 * `PaymongoNotConfiguredError` and the action returns a friendly message.
 *
 * There is deliberately NO "mark as paid" action. `Order.paymentStatus` /
 * `Order.status` are only ever advanced by the signature-verified webhook
 * (src/lib/payments/webhook.ts). Reconciliation re-reads the provider's own
 * record — it never trusts an admin's assertion that a payment happened.
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
