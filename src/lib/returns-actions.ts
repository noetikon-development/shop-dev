"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { cleanUserText } from "@/lib/ugc";
import { hitRateLimit } from "@/lib/rate-limit";
import { scheduleEmail } from "@/lib/email/schedule";
import { sendReturnRequested, sendReturnInbound } from "@/lib/email/notifications";
import {
  returnEligibility,
  describeIneligibility,
  nextReturnNumber,
} from "@/lib/returns";
import { RETURN_LIMITS, isReturnReason, customerCanCancel } from "@/lib/returns/status";

/**
 * Customer-facing returns actions (Step 21 P3).
 *
 * Security model:
 *  - the authenticated user is resolved server-side (getCurrentUser); the client
 *    never sends a userId.
 *  - the order and every line are re-validated against `returnEligibility`,
 *    scoped to `userId` — a customer cannot open a return against another
 *    customer's order, an undelivered order, an expired window, or an order that
 *    already has an open return.
 *  - the client sends only `orderNumber`, `reason`, `note` and per-line
 *    quantities. It cannot set status, refund amount / method, restock quantity
 *    or staffNote (those fields aren't read from the payload at all).
 *  - line snapshots (name / sku / unitPrice / variantLabel) are copied from the
 *    authoritative OrderItem, never from the request.
 */

export type ReturnFormState = {
  ok?: boolean;
  error?: string;
  returnNumber?: string;
  fieldErrors?: Partial<Record<"reason" | "note" | "items", string>>;
};

const CUSTOMER_NOTE_MAX = RETURN_LIMITS.noteMax;
const RATE = { limit: 10, windowMs: 60 * 60 * 1000 }; // 10 return requests / hour / user

export async function requestReturnAction(
  _prev: ReturnFormState,
  formData: FormData,
): Promise<ReturnFormState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in to start a return." };

  const orderNumber = String(formData.get("orderNumber") ?? "").trim();
  const reason = String(formData.get("reason") ?? "").trim();
  const note = cleanUserText(formData.get("note")).slice(0, CUSTOMER_NOTE_MAX);

  if (!isReturnReason(reason)) {
    return { ok: false, fieldErrors: { reason: "Choose a reason for your return." } };
  }

  // Parse the per-line quantities: inputs named "qty:<orderItemId>".
  const requested: { orderItemId: string; quantity: number }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("qty:")) continue;
    const orderItemId = key.slice(4);
    const n = Number(value);
    if (orderItemId && Number.isInteger(n) && n > 0) {
      requested.push({ orderItemId, quantity: n });
    }
  }
  if (requested.length === 0) {
    return { ok: false, fieldErrors: { items: "Choose at least one item and quantity to return." } };
  }

  const rl = await hitRateLimit(`return:user:${user.id}`, RATE);
  if (!rl.ok) {
    return { ok: false, error: "You've started several returns recently. Please try again in a little while." };
  }

  const elig = await returnEligibility(user.id, orderNumber);
  if (!elig.eligible) return { ok: false, error: describeIneligibility(elig.code) };

  const eligibleById = new Map(elig.lines.map((l) => [l.orderItemId, l]));
  const items: Prisma.ReturnItemUncheckedCreateWithoutReturnRequestInput[] = [];
  for (const r of requested) {
    const line = eligibleById.get(r.orderItemId);
    if (!line) return { ok: false, error: "One of the selected items isn't on this order." };
    if (r.quantity > line.remaining) {
      return {
        ok: false,
        fieldErrors: { items: `You can return at most ${line.remaining} of “${line.name}”.` },
      };
    }
    items.push({
      orderItemId: line.orderItemId,
      productId: line.productId,
      variantId: line.variantId,
      name: line.name,
      variantLabel: line.variantLabel,
      sku: line.sku,
      unitPrice: line.unitPrice,
      quantity: r.quantity,
      refundAmount: line.unitPrice * r.quantity,
    });
  }

  let created: { id: string; returnNumber: string };
  try {
    created = await prisma.$transaction(async (tx) => {
      const returnNumber = await nextReturnNumber(tx);
      return tx.returnRequest.create({
        data: {
          returnNumber,
          orderId: elig.order.id,
          userId: user.id,
          status: "REQUESTED",
          reason,
          customerNote: note || null,
          adminAssisted: false,
          items: { create: items },
        },
        select: { id: true, returnNumber: true },
      });
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // The partial unique index (return_one_open_per_order) fired — a concurrent
      // request beat this one.
      return { ok: false, error: "There's already an open return for this order." };
    }
    console.error("[returns] requestReturnAction failed", err);
    return { ok: false, error: "Something went wrong creating your return. Please try again." };
  }

  scheduleEmail(() => sendReturnRequested(created.id));
  scheduleEmail(() => sendReturnInbound(created.id));

  revalidatePath("/account/returns");
  revalidatePath(`/account/orders/${orderNumber}`);
  return { ok: true, returnNumber: created.returnNumber };
}

const cancelSchema = z.object({ returnNumber: z.string().min(1).max(40) });

export async function cancelReturnAction(input: unknown): Promise<ReturnFormState> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in." };

  const parsed = cancelSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const ret = await prisma.returnRequest.findFirst({
    where: { returnNumber: parsed.data.returnNumber, userId: user.id },
    select: { id: true, status: true, order: { select: { orderNumber: true } } },
  });
  if (!ret) return { ok: false, error: "That return wasn't found." };
  if (!customerCanCancel(ret.status)) {
    return { ok: false, error: "This return can no longer be withdrawn." };
  }

  const res = await prisma.returnRequest.updateMany({
    where: { id: ret.id, status: "REQUESTED" },
    data: { status: "CANCELLED" },
  });
  if (res.count === 0) return { ok: false, error: "This return was just updated — refresh and try again." };

  revalidatePath("/account/returns");
  revalidatePath(`/account/returns/${parsed.data.returnNumber}`);
  if (ret.order?.orderNumber) revalidatePath(`/account/orders/${ret.order.orderNumber}`);
  return { ok: true };
}
