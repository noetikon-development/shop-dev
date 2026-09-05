"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { adjustStock } from "@/lib/inventory";
import { restoreOfferStock } from "@/lib/marketplace/offer-inventory";
import { cleanUserText } from "@/lib/ugc";
import { scheduleEmail } from "@/lib/email/schedule";
import {
  sendReturnApproved,
  sendReturnRejected,
  sendReturnReceived,
  sendReturnRefundInitiated,
  sendReturnRefundCompleted,
  sendReturnRequested,
  sendReturnInbound,
  sendRefundIssued,
  sendReturnRefundInitiatedOps,
  sendReturnRefundCompletedOps,
  sendSellerReturnReceived,
  getReturnAffectedSellerIds,
} from "@/lib/email/notifications";
import {
  canTransitionReturn,
  returnStatusLabel,
  adminCanCancel,
  isReturnReason,
  isReturnItemCondition,
  RETURN_LIMITS,
} from "@/lib/returns/status";
import { nextReturnNumber, remainingReturnableByOrderItem, getReturnsConfig } from "@/lib/returns";
import { refundRouteForOrder, initiateProviderRefund } from "@/lib/payments/refund";
import { hasPermission } from "@/lib/admin/rbac";

/**
 * Admin returns / RMA actions (Step 21 P3).
 *
 * - Every mutation requires `manage_returns` (the one permission added for P3).
 * - Every transition is validated server-side against `canTransitionReturn` and
 *   applied with an atomic status-guarded `updateMany` (0 rows ⇒ concurrent
 *   change ⇒ abort). The client can never post an arbitrary status.
 * - `Order` / `OrderItem` are never mutated. Restock: an offer-native order
 *   (SALE `OfferAdjustment` present) restocks `OfferInventory` per
 *   `ReturnItem → OrderItem.offerId` and creates `OfferAdjustment(RETURN)` —
 *   that is the WHOLE restock since Phase 9E-3D-5, the `Inventory` mirror is not
 *   touched. A legacy (pre-retirement) order restocks `Inventory` only (the
 *   retained fallback). Idempotent via `ReturnRequest.restockedAt`.
 * - Refunds are BOOKKEEPING ONLY — `Order.paymentStatus` is not touched, no
 *   Payment / gateway record is created.
 * - Every action writes an `AdminAuditLog` entry and schedules the matching
 *   customer email (SKIPPED until SMTP).
 * - `staffNote` is internal: appended with an actor/action prefix, never emailed.
 */

export type ReturnAdminState = {
  ok: boolean;
  message?: string;
  error?: string;
  returnId?: string;
  fieldErrors?: Record<string, string>;
};

class StaleReturnError extends Error {}

const idField = z.string().min(1).max(64);

function clean(value: unknown, max: number): string | null {
  const v = cleanUserText(value).slice(0, max);
  return v || null;
}

/** Append an internal staff note line, keeping earlier notes. */
function appendStaffNote(
  existing: string | null,
  actorEmail: string,
  action: string,
  text: string | null,
): string | null {
  if (!text) return existing;
  const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
  const line = `[${stamp} · ${action} · ${actorEmail}] ${text}`;
  return existing ? `${existing}\n${line}` : line;
}

/**
 * Round to the nearest centavo, halves away from zero — same rule
 * `checkout.ts` uses for the original commission calculation (9E-3B §15),
 * duplicated locally so this file doesn't import from checkout's internals.
 */
function roundHalfUp(x: number): number {
  return Math.sign(x) * Math.round(Math.abs(x));
}

function revalidateReturn(id: string, returnNumber?: string, orderNumber?: string) {
  revalidatePath("/admin/returns");
  revalidatePath(`/admin/returns/${id}`);
  revalidatePath("/account/returns");
  if (returnNumber) revalidatePath(`/account/returns/${returnNumber}`);
  if (orderNumber) revalidatePath(`/account/orders/${orderNumber}`);
}

const RETURN_SELECT = {
  id: true,
  returnNumber: true,
  status: true,
  restockedAt: true,
  staffNote: true,
  refundAmount: true,
  order: { select: { id: true, orderNumber: true, grandTotal: true, subtotal: true, shippingFee: true, paymentMethod: true } },
  items: {
    orderBy: { id: "asc" as const },
    select: { id: true, orderItemId: true, variantId: true, name: true, quantity: true, refundAmount: true },
  },
} satisfies Prisma.ReturnRequestSelect;

async function loadReturn(id: string) {
  return prisma.returnRequest.findUnique({ where: { id }, select: RETURN_SELECT });
}

// ---------------------------------------------------------------------------
// Approve  (REQUESTED → APPROVED)
// ---------------------------------------------------------------------------

const approveSchema = z.object({
  returnId: idField,
  resolutionNote: z.string().max(8000).optional(),
  staffNote: z.string().max(8000).optional(),
});

export async function approveReturnAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = approveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const ret = await loadReturn(parsed.data.returnId);
  if (!ret) return { ok: false, error: "Return not found." };
  if (!canTransitionReturn(ret.status, "APPROVED")) {
    return { ok: false, error: `A return that is ${returnStatusLabel(ret.status)} can’t be approved.` };
  }

  const resolutionNote = clean(parsed.data.resolutionNote, RETURN_LIMITS.resolutionNoteMax);
  const staffNote = appendStaffNote(
    ret.staffNote,
    admin.user.email,
    "approved",
    clean(parsed.data.staffNote, RETURN_LIMITS.staffNoteMax),
  );

  const res = await prisma.returnRequest.updateMany({
    where: { id: ret.id, status: "REQUESTED" },
    data: { status: "APPROVED", resolutionNote, staffNote },
  });
  if (res.count === 0) return { ok: false, error: "The return was updated elsewhere — refresh and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.approved",
    targetType: "return",
    targetId: ret.id,
    summary: `${admin.user.email} approved return ${ret.returnNumber} (order ${ret.order.orderNumber})`,
    meta: { returnNumber: ret.returnNumber, orderNumber: ret.order.orderNumber, from: "REQUESTED", to: "APPROVED" },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  scheduleEmail(() => sendReturnApproved(ret.id));
  return { ok: true, message: "Return approved.", returnId: ret.id };
}

// ---------------------------------------------------------------------------
// Reject  (REQUESTED → REJECTED)
// ---------------------------------------------------------------------------

const rejectSchema = z.object({
  returnId: idField,
  resolutionNote: z.string().trim().min(1, "Give the customer a reason.").max(8000),
  staffNote: z.string().max(8000).optional(),
});

export async function rejectReturnAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = rejectSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Please give the customer a reason for rejecting the return." };
  }

  const ret = await loadReturn(parsed.data.returnId);
  if (!ret) return { ok: false, error: "Return not found." };
  if (!canTransitionReturn(ret.status, "REJECTED")) {
    return { ok: false, error: `A return that is ${returnStatusLabel(ret.status)} can’t be rejected.` };
  }

  const resolutionNote = clean(parsed.data.resolutionNote, RETURN_LIMITS.resolutionNoteMax);
  const staffNote = appendStaffNote(
    ret.staffNote,
    admin.user.email,
    "rejected",
    clean(parsed.data.staffNote, RETURN_LIMITS.staffNoteMax),
  );

  const res = await prisma.returnRequest.updateMany({
    where: { id: ret.id, status: "REQUESTED" },
    data: { status: "REJECTED", resolutionNote, staffNote },
  });
  if (res.count === 0) return { ok: false, error: "The return was updated elsewhere — refresh and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.rejected",
    targetType: "return",
    targetId: ret.id,
    summary: `${admin.user.email} rejected return ${ret.returnNumber} (order ${ret.order.orderNumber})`,
    meta: { returnNumber: ret.returnNumber, orderNumber: ret.order.orderNumber, from: "REQUESTED", to: "REJECTED" },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  scheduleEmail(() => sendReturnRejected(ret.id));
  return { ok: true, message: "Return rejected.", returnId: ret.id };
}

// ---------------------------------------------------------------------------
// Mark received (+ restock)  (APPROVED → RECEIVED)
// ---------------------------------------------------------------------------

const receiveSchema = z.object({
  returnId: idField,
  lines: z
    .array(
      z.object({
        returnItemId: idField,
        restockQuantity: z.coerce.number().int().min(0),
        condition: z.string().max(20).optional(),
      }),
    )
    .min(1),
  staffNote: z.string().max(8000).optional(),
});

export async function receiveReturnAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = receiveSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const ret = await loadReturn(parsed.data.returnId);
  if (!ret) return { ok: false, error: "Return not found." };
  if (!canTransitionReturn(ret.status, "RECEIVED")) {
    return { ok: false, error: `A return that is ${returnStatusLabel(ret.status)} can’t be marked received.` };
  }

  const itemById = new Map(ret.items.map((i) => [i.id, i]));
  const lines: { item: (typeof ret.items)[number]; restockQuantity: number; condition: string | null }[] = [];
  for (const l of parsed.data.lines) {
    const item = itemById.get(l.returnItemId);
    if (!item) return { ok: false, error: "One of the lines isn’t part of this return." };
    if (l.restockQuantity < 0 || l.restockQuantity > item.quantity) {
      return {
        ok: false,
        fieldErrors: { [l.returnItemId]: `Restock 0–${item.quantity} of “${item.name}”.` },
      };
    }
    const condition = l.condition && isReturnItemCondition(l.condition) ? l.condition : null;
    lines.push({ item, restockQuantity: l.restockQuantity, condition });
  }

  const staffNote = appendStaffNote(
    ret.staffNote,
    admin.user.email,
    "received",
    clean(parsed.data.staffNote, RETURN_LIMITS.staffNoteMax),
  );

  const restocked: { name: string; qty: number }[] = [];
  const skippedRestock: string[] = [];
  let restockPath: "offer-native" | "legacy" = "legacy";

  try {
    await prisma.$transaction(async (tx) => {
      // Idempotency: `restockedAt` set-once + status guard. A repeated receive
      // matches 0 rows and never re-restocks.
      const res = await tx.returnRequest.updateMany({
        where: { id: ret.id, status: "APPROVED", restockedAt: null },
        data: { status: "RECEIVED", restockedAt: new Date(), staffNote },
      });
      if (res.count === 0) throw new StaleReturnError();

      // An offer-native order (detected by a SALE `OfferAdjustment`) restocks
      // `OfferInventory` per `ReturnItem → OrderItem.offerId` and creates
      // `OfferAdjustment(RETURN)` — the whole restock since Phase 9E-3D-5, no
      // `Inventory` write / lock. A legacy (pre-retirement) order restocks
      // `Inventory` only (the retained fallback, §7).
      const saleOfferAdjustments = await tx.offerAdjustment.count({
        where: { reason: "SALE", note: `Order ${ret.order.orderNumber}` },
      });
      const offerNative = saleOfferAdjustments > 0;
      restockPath = offerNative ? "offer-native" : "legacy";

      // Resolve each return line's bound Offer via its order line (offer-native).
      const orderItemIds = lines.map((l) => l.item.orderItemId).filter(Boolean) as string[];
      const offerByOrderItem = new Map<string, { offerId: string | null; sellerType: string }>();
      if (offerNative && orderItemIds.length > 0) {
        const ois = await tx.orderItem.findMany({
          where: { id: { in: orderItemIds } },
          select: { id: true, offerId: true, offer: { select: { seller: { select: { type: true } } } } },
        });
        for (const oi of ois) {
          offerByOrderItem.set(oi.id, {
            offerId: oi.offerId,
            sellerType: oi.offer?.seller.type ?? "FIRST_PARTY",
          });
        }
      }

      // 9F-8c — commission correction. The commission on a returned unit was
      // earned on a sale that's now being refunded, so it's reduced by the
      // returned units' snapshotted value regardless of restock eligibility
      // (a damaged, non-resellable unit is still being refunded). Scoped per
      // affected SellerOrder via `OrderItem.sellerOrderId` — a return's items
      // are always all from the same parent Order, so today this is at most
      // one SellerOrder, but the code doesn't assume that. Guarded by the
      // SAME `restockedAt` set-once check above (already thrown before this
      // point on a repeat), so this can never double-adjust. A legacy order
      // item with no `sellerOrderId` contributes nothing (pre-marketplace,
      // no commission was ever recorded for it).
      if (orderItemIds.length > 0) {
        const owners = await tx.orderItem.findMany({
          where: { id: { in: orderItemIds } },
          select: { id: true, sellerOrderId: true },
        });
        const sellerOrderByOrderItem = new Map(owners.map((oi) => [oi.id, oi.sellerOrderId]));
        const returnedValueBySellerOrder = new Map<string, number>();
        for (const l of lines) {
          const sellerOrderId = l.item.orderItemId ? sellerOrderByOrderItem.get(l.item.orderItemId) : null;
          if (!sellerOrderId) continue;
          returnedValueBySellerOrder.set(
            sellerOrderId,
            (returnedValueBySellerOrder.get(sellerOrderId) ?? 0) + l.item.refundAmount,
          );
        }
        for (const [sellerOrderId, returnedValue] of returnedValueBySellerOrder) {
          if (returnedValue <= 0) continue;
          const so = await tx.sellerOrder.findUnique({
            where: { id: sellerOrderId },
            select: { commissionAmount: true, commissionRate: true },
          });
          if (!so) continue;
          const commissionAdjustment = roundHalfUp((returnedValue * so.commissionRate) / 10000);
          await tx.sellerOrder.update({
            where: { id: sellerOrderId },
            data: { commissionAmount: Math.max(0, so.commissionAmount - commissionAdjustment) },
          });
        }
      }

      for (const l of lines) {
        await tx.returnItem.update({
          where: { id: l.item.id },
          data: { restockQuantity: l.restockQuantity, condition: l.condition },
        });
        if (l.restockQuantity <= 0) continue;

        const bound = l.item.orderItemId ? offerByOrderItem.get(l.item.orderItemId) : undefined;
        const useOfferPath = offerNative && bound?.offerId;

        // OFFER-NATIVE line — restore OfferInventory ONLY + OfferAdjustment(RETURN).
        // No Inventory read / lock / write since Phase 9E-3D-5 (§6/§12/§13).
        if (useOfferPath) {
          const oRes = await restoreOfferStock(
            {
              offerId: bound!.offerId!,
              units: l.restockQuantity,
              reason: "RETURN",
              note: `Return ${ret.returnNumber} (order ${ret.order.orderNumber}) · item ${l.item.orderItemId}`,
              actorUserId: admin.user.id,
            },
            tx,
          );
          if (!oRes.ok) throw new Error(oRes.error ?? "Could not restock a line — receipt aborted.");
          restocked.push({ name: l.item.name, qty: l.restockQuantity });
          continue;
        }

        // LEGACY line — restore the Inventory mirror (the whole restock for a
        // pre-retirement order). Retained fallback (§7 — do NOT invent an Offer
        // mapping). A (future) 3P line with no Inventory row is skipped.
        const isThirdParty = bound?.sellerType === "THIRD_PARTY";
        if (!l.item.variantId || isThirdParty) {
          skippedRestock.push(l.item.name);
          continue;
        }
        const inv = await tx.inventory.findUnique({
          where: { variantId: l.item.variantId },
          select: { id: true },
        });
        if (!inv) {
          skippedRestock.push(l.item.name);
          continue;
        }
        const adj = await adjustStock(
          {
            variantId: l.item.variantId,
            delta: l.restockQuantity,
            reason: "RETURN",
            note: `Return ${ret.returnNumber} (order ${ret.order.orderNumber})`,
            actorUserId: admin.user.id,
          },
          tx,
        );
        if (!adj.ok) throw new Error(adj.error ?? "Could not restock a line — receipt aborted.");
        restocked.push({ name: l.item.name, qty: l.restockQuantity });
      }
    });
  } catch (err) {
    if (err instanceof StaleReturnError) {
      return { ok: false, error: "The return was updated elsewhere — refresh and try again." };
    }
    if (err instanceof Error) return { ok: false, error: err.message };
    throw err;
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.received",
    targetType: "return",
    targetId: ret.id,
    summary:
      `${admin.user.email} received return ${ret.returnNumber} (order ${ret.order.orderNumber}); ` +
      `restocked ${restocked.reduce((n, r) => n + r.qty, 0)} unit(s) across ${restocked.length} line(s)` +
      (skippedRestock.length ? `; ${skippedRestock.length} line(s) not restocked` : "") +
      ` [${restockPath}]`,
    meta: {
      returnNumber: ret.returnNumber,
      orderNumber: ret.order.orderNumber,
      from: "APPROVED",
      to: "RECEIVED",
      restockPath,
      restocked,
      skippedRestock,
    },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  scheduleEmail(() => sendReturnReceived(ret.id));

  // Marketplace (9F-7b) — notify each seller whose line(s) are part of this
  // return. Admin-triggered only; the seller's own receipt confirmation
  // (`sellerReceiveReturnAction`) does not duplicate this — it already knows.
  const affectedSellerIds = await getReturnAffectedSellerIds(ret.id);
  for (const sellerId of affectedSellerIds) {
    scheduleEmail(() => sendSellerReturnReceived(ret.id, sellerId));
  }

  return {
    ok: true,
    message:
      restocked.length > 0
        ? `Return received. ${restocked.reduce((n, r) => n + r.qty, 0)} unit(s) returned to stock.`
        : "Return received.",
    returnId: ret.id,
  };
}

// ---------------------------------------------------------------------------
// Initiate refund — BOOKKEEPING ONLY  (RECEIVED → REFUND_INITIATED)
// ---------------------------------------------------------------------------

const initiateRefundSchema = z.object({
  returnId: idField,
  refundAmount: z.coerce.number().int().min(1, "Enter a refund amount."),
  refundMethod: z.string().trim().min(1, "Say how the refund is being made.").max(120),
  refundReference: z.string().trim().max(120).optional(),
  staffNote: z.string().max(8000).optional(),
});

export async function initiateRefundAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = initiateRefundSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Enter a valid refund amount and method." };
  }

  const ret = await loadReturn(parsed.data.returnId);
  if (!ret) return { ok: false, error: "Return not found." };
  if (!canTransitionReturn(ret.status, "REFUND_INITIATED")) {
    return { ok: false, error: `A return that is ${returnStatusLabel(ret.status)} isn’t ready for a refund.` };
  }
  if (parsed.data.refundAmount > ret.order.grandTotal) {
    return {
      ok: false,
      fieldErrors: { refundAmount: "The refund can’t be more than the order total." },
    };
  }

  const staffNote = appendStaffNote(
    ret.staffNote,
    admin.user.email,
    "refund initiated",
    clean(parsed.data.staffNote, RETURN_LIMITS.staffNoteMax),
  );

  // Routing (Step 21 P4). DORMANT in Phase 4-A: `refundRouteForOrder` always
  // returns "bookkeeping" while online payment is disabled, so the block below
  // runs and the existing P3 behaviour is byte-identical.
  const routing = await refundRouteForOrder(ret.order.id);

  if (routing.route === "provider") {
    if (!(admin.isSuperAdmin || hasPermission(admin, "issue_refunds"))) {
      return { ok: false, error: "Issuing a refund to the customer’s payment method needs the ‘issue refunds’ permission." };
    }
    if (parsed.data.refundAmount > routing.payment.amount - routing.alreadyRefunded) {
      return {
        ok: false,
        fieldErrors: { refundAmount: "That’s more than the remaining refundable amount on this payment." },
      };
    }
    const claimed = await prisma.returnRequest.updateMany({
      where: { id: ret.id, status: "RECEIVED" },
      data: { status: "REFUND_INITIATED", refundInitiatedAt: new Date(), staffNote },
    });
    if (claimed.count === 0) return { ok: false, error: "The return was updated elsewhere — refresh and try again." };

    const provider = await initiateProviderRefund({
      returnRequestId: ret.id,
      paymentId: routing.payment.id,
      providerPaymentId: routing.payment.providerId,
      amount: parsed.data.refundAmount,
      reason: "requested_by_customer",
    });
    if (!provider.ok) {
      // Roll the return back so an admin can retry or fall back to bookkeeping.
      await prisma.returnRequest.updateMany({
        where: { id: ret.id, status: "REFUND_INITIATED" },
        data: { status: "RECEIVED", refundInitiatedAt: null },
      });
      return { ok: false, error: `Refund could not be issued: ${provider.error}` };
    }

    await prisma.returnRequest.update({
      where: { id: ret.id },
      data: {
        refundAmount: parsed.data.refundAmount,
        refundMethod: `Original ${routing.payment.method ?? "payment method"} via PayMongo`,
        refundReference: provider.paymentRefundId,
      },
    });
    await writeAudit({
      actorUserId: admin.user.id,
      action: "return.refund_issued",
      targetType: "return",
      targetId: ret.id,
      summary: `${admin.user.email} issued a PayMongo refund of ${parsed.data.refundAmount} centavos for return ${ret.returnNumber}`,
      meta: { returnNumber: ret.returnNumber, orderNumber: ret.order.orderNumber, paymentRefundId: provider.paymentRefundId, bookkeepingOnly: false },
    });
    revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
    scheduleEmail(() => sendRefundIssued(provider.paymentRefundId));
    return { ok: true, message: "Refund issued to the customer’s payment method. It will complete automatically.", returnId: ret.id };
  }

  // --- bookkeeping path (unchanged from P3) ---------------------------------
  const res = await prisma.returnRequest.updateMany({
    where: { id: ret.id, status: "RECEIVED" },
    data: {
      status: "REFUND_INITIATED",
      refundAmount: parsed.data.refundAmount,
      refundMethod: parsed.data.refundMethod,
      refundReference: parsed.data.refundReference || null,
      refundInitiatedAt: new Date(),
      staffNote,
    },
  });
  if (res.count === 0) return { ok: false, error: "The return was updated elsewhere — refresh and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.refund_initiated",
    targetType: "return",
    targetId: ret.id,
    summary: `${admin.user.email} recorded a refund of ${parsed.data.refundAmount} centavos for return ${ret.returnNumber} (bookkeeping only)`,
    meta: {
      returnNumber: ret.returnNumber,
      orderNumber: ret.order.orderNumber,
      from: "RECEIVED",
      to: "REFUND_INITIATED",
      refundAmount: parsed.data.refundAmount,
      refundMethod: parsed.data.refundMethod,
      refundReference: parsed.data.refundReference || null,
      bookkeepingOnly: true,
    },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  scheduleEmail(() => sendReturnRefundInitiated(ret.id));
  // Axiaro Operations companion (9F-7b) — bookkeeping-only refund path only;
  // the PayMongo-routed `refund_issued` above stays untouched/dormant.
  scheduleEmail(() => sendReturnRefundInitiatedOps(ret.id));
  return { ok: true, message: "Refund recorded (bookkeeping only).", returnId: ret.id };
}

// ---------------------------------------------------------------------------
// Complete refund — BOOKKEEPING ONLY  (REFUND_INITIATED → REFUND_COMPLETED)
// ---------------------------------------------------------------------------

const completeRefundSchema = z.object({
  returnId: idField,
  refundReference: z.string().trim().max(120).optional(),
  staffNote: z.string().max(8000).optional(),
});

export async function completeRefundAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = completeRefundSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const ret = await loadReturn(parsed.data.returnId);
  if (!ret) return { ok: false, error: "Return not found." };
  if (!canTransitionReturn(ret.status, "REFUND_COMPLETED")) {
    return { ok: false, error: `A return that is ${returnStatusLabel(ret.status)} can’t be marked refunded.` };
  }

  // A provider (PayMongo) refund completes itself via the webhook — the manual
  // step is only for bookkeeping refunds. DORMANT in Phase 4-A.
  const providerRefund = await prisma.paymentRefund.findFirst({
    where: { returnRequestId: ret.id },
    select: { status: true },
  });
  if (providerRefund && providerRefund.status !== "FAILED") {
    return {
      ok: false,
      error: "This refund is being processed by PayMongo and will be marked complete automatically.",
    };
  }

  const staffNote = appendStaffNote(
    ret.staffNote,
    admin.user.email,
    "refund completed",
    clean(parsed.data.staffNote, RETURN_LIMITS.staffNoteMax),
  );

  const res = await prisma.returnRequest.updateMany({
    where: { id: ret.id, status: "REFUND_INITIATED" },
    data: {
      status: "REFUND_COMPLETED",
      refundCompletedAt: new Date(),
      ...(parsed.data.refundReference ? { refundReference: parsed.data.refundReference } : {}),
      staffNote,
    },
  });
  if (res.count === 0) return { ok: false, error: "The return was updated elsewhere — refresh and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.refund_completed",
    targetType: "return",
    targetId: ret.id,
    summary: `${admin.user.email} marked the refund for return ${ret.returnNumber} complete (bookkeeping only)`,
    meta: {
      returnNumber: ret.returnNumber,
      orderNumber: ret.order.orderNumber,
      from: "REFUND_INITIATED",
      to: "REFUND_COMPLETED",
      bookkeepingOnly: true,
    },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  scheduleEmail(() => sendReturnRefundCompleted(ret.id));
  // Axiaro Operations companion (9F-7b) — bookkeeping-only refund path only.
  scheduleEmail(() => sendReturnRefundCompletedOps(ret.id));
  return { ok: true, message: "Refund marked complete (bookkeeping only).", returnId: ret.id };
}

// ---------------------------------------------------------------------------
// Cancel (admin)  (any non-terminal → CANCELLED)
// ---------------------------------------------------------------------------

const cancelSchema = z.object({
  returnId: idField,
  reason: z.string().trim().min(1, "Give a reason.").max(300),
});

export async function cancelReturnAdminAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Give a reason for cancelling the return." };

  const ret = await loadReturn(parsed.data.returnId);
  if (!ret) return { ok: false, error: "Return not found." };
  if (!adminCanCancel(ret.status) || !canTransitionReturn(ret.status, "CANCELLED")) {
    return { ok: false, error: `A return that is ${returnStatusLabel(ret.status)} can’t be cancelled.` };
  }

  const staffNote = appendStaffNote(ret.staffNote, admin.user.email, "cancelled", parsed.data.reason);

  const res = await prisma.returnRequest.updateMany({
    where: { id: ret.id, status: ret.status },
    data: { status: "CANCELLED", staffNote },
  });
  if (res.count === 0) return { ok: false, error: "The return was updated elsewhere — refresh and try again." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.cancelled",
    targetType: "return",
    targetId: ret.id,
    summary: `${admin.user.email} cancelled return ${ret.returnNumber} (was ${returnStatusLabel(ret.status)})`,
    meta: {
      returnNumber: ret.returnNumber,
      orderNumber: ret.order.orderNumber,
      from: ret.status,
      to: "CANCELLED",
      reason: parsed.data.reason,
    },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  return { ok: true, message: "Return cancelled.", returnId: ret.id };
}

// ---------------------------------------------------------------------------
// Admin-assisted create (from the order page)
// ---------------------------------------------------------------------------

const adminCreateSchema = z.object({
  orderId: idField,
  reason: z.string(),
  customerNote: z.string().max(4000).optional(),
  staffNote: z.string().max(8000).optional(),
  lines: z
    .array(z.object({ orderItemId: idField, quantity: z.coerce.number().int().min(1) }))
    .min(1),
});

export async function adminCreateReturnAction(input: unknown): Promise<ReturnAdminState> {
  const admin = await requirePermission("manage_returns");
  const parsed = adminCreateSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };
  if (!isReturnReason(parsed.data.reason)) {
    return { ok: false, fieldErrors: { reason: "Choose a reason." } };
  }

  const order = await prisma.order.findUnique({
    where: { id: parsed.data.orderId },
    select: {
      id: true,
      orderNumber: true,
      email: true,
      userId: true,
      status: true,
      placedAt: true,
      deliveredAt: true,
      items: {
        orderBy: { id: "asc" },
        select: {
          id: true,
          productId: true,
          variantId: true,
          name: true,
          variantLabel: true,
          sku: true,
          unitPrice: true,
          quantity: true,
        },
      },
    },
  });
  if (!order) return { ok: false, error: "Order not found." };

  const openReturn = await prisma.returnRequest.findFirst({
    where: { orderId: order.id, status: { notIn: ["REJECTED", "CANCELLED", "REFUND_COMPLETED"] } },
    select: { returnNumber: true },
  });
  if (openReturn) {
    return { ok: false, error: `This order already has an open return (${openReturn.returnNumber}).` };
  }

  // Soft eligibility — admins may assist with undelivered / late returns, but
  // every override is recorded.
  const overridden: string[] = [];
  if (order.status !== "DELIVERED") overridden.push("status");
  const { windowDays } = await getReturnsConfig();
  const since = order.deliveredAt ?? order.placedAt;
  if (Date.now() > since.getTime() + windowDays * 24 * 60 * 60 * 1000) overridden.push("window");

  const remaining = await remainingReturnableByOrderItem(order.id);
  const orderItemById = new Map(order.items.map((i) => [i.id, i]));
  const items: Prisma.ReturnItemUncheckedCreateWithoutReturnRequestInput[] = [];
  for (const l of parsed.data.lines) {
    const it = orderItemById.get(l.orderItemId);
    if (!it) return { ok: false, error: "One of the selected lines isn’t on this order." };
    const rem = remaining.get(it.id) ?? 0;
    if (l.quantity > rem) {
      return { ok: false, error: `At most ${rem} of “${it.name}” can still be returned.` };
    }
    items.push({
      orderItemId: it.id,
      productId: it.productId,
      variantId: it.variantId,
      name: it.name,
      variantLabel: it.variantLabel,
      sku: it.sku,
      unitPrice: it.unitPrice,
      quantity: l.quantity,
      refundAmount: it.unitPrice * l.quantity,
    });
  }
  if (items.length === 0) return { ok: false, error: "Nothing to return." };

  let created: { id: string; returnNumber: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      const returnNumber = await nextReturnNumber(tx);
      return tx.returnRequest.create({
        data: {
          returnNumber,
          orderId: order.id,
          userId: order.userId,
          status: "REQUESTED",
          reason: parsed.data.reason,
          customerNote: clean(parsed.data.customerNote, RETURN_LIMITS.noteMax),
          staffNote: appendStaffNote(
            null,
            admin.user.email,
            "created (assisted)",
            clean(parsed.data.staffNote, RETURN_LIMITS.staffNoteMax),
          ),
          adminAssisted: true,
          overriddenRules: overridden.length ? JSON.stringify(overridden) : null,
          items: { create: items },
        },
        select: { id: true, returnNumber: true },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: "This order already has an open return." };
    }
    console.error("[returns] adminCreateReturnAction failed", err);
    return { ok: false, error: "Something went wrong creating the return." };
  }

  await writeAudit({
    actorUserId: admin.user.id,
    action: "return.requested",
    targetType: "return",
    targetId: created.id,
    summary:
      `${admin.user.email} created assisted return ${created.returnNumber} for order ${order.orderNumber}` +
      (overridden.length ? ` (overrode: ${overridden.join(", ")})` : ""),
    meta: {
      returnNumber: created.returnNumber,
      orderNumber: order.orderNumber,
      adminAssisted: true,
      overriddenRules: overridden,
    },
  });

  scheduleEmail(() => sendReturnRequested(created.id));
  scheduleEmail(() => sendReturnInbound(created.id));

  revalidateReturn(created.id, created.returnNumber, order.orderNumber);
  return { ok: true, message: `Return ${created.returnNumber} created.`, returnId: created.id };
}
