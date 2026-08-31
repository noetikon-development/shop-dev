"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { adjustStock } from "@/lib/inventory";
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

/**
 * Admin returns / RMA actions (Step 21 P3).
 *
 * - Every mutation requires `manage_returns` (the one permission added for P3).
 * - Every transition is validated server-side against `canTransitionReturn` and
 *   applied with an atomic status-guarded `updateMany` (0 rows ⇒ concurrent
 *   change ⇒ abort). The client can never post an arbitrary status.
 * - `Order` / `OrderItem` are never mutated. Restock goes through the existing
 *   row-locked `adjustStock` primitive with reason "RETURN".
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
    select: { id: true, variantId: true, name: true, quantity: true, refundAmount: true },
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

  try {
    await prisma.$transaction(async (tx) => {
      const res = await tx.returnRequest.updateMany({
        where: { id: ret.id, status: "APPROVED", restockedAt: null },
        data: { status: "RECEIVED", restockedAt: new Date(), staffNote },
      });
      if (res.count === 0) throw new StaleReturnError();

      for (const l of lines) {
        await tx.returnItem.update({
          where: { id: l.item.id },
          data: { restockQuantity: l.restockQuantity, condition: l.condition },
        });
        if (l.restockQuantity <= 0) continue;
        if (!l.item.variantId) {
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
      (skippedRestock.length ? `; ${skippedRestock.length} line(s) not restocked` : ""),
    meta: {
      returnNumber: ret.returnNumber,
      orderNumber: ret.order.orderNumber,
      from: "APPROVED",
      to: "RECEIVED",
      restocked,
      skippedRestock,
    },
  });

  revalidateReturn(ret.id, ret.returnNumber, ret.order.orderNumber);
  scheduleEmail(() => sendReturnReceived(ret.id));
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
