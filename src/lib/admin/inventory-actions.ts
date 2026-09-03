"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { adjustStock, setReorderPoint } from "@/lib/inventory";
import { getFirstPartyStock } from "@/lib/admin/first-party-inventory";
import {
  syncFirstPartyOfferStock,
  syncFirstPartyOfferReorderPoint,
} from "@/lib/admin/offer-sync";

export type InventoryActionState = {
  error?: string;
  fieldErrors?: Record<string, string>;
  ok?: boolean;
  message?: string;
};

/**
 * Carries a message that is SAFE to show an admin verbatim — the user-facing
 * copy from `adjustStock` / `setReorderPoint`, or a curated fallback. Anything
 * thrown inside the transaction that is NOT an `AdjustError` (a raw Prisma
 * error, the internal `syncFirstPartyOfferStock` invariant message, …) is
 * logged server-side and replaced with a generic message — no SQL, schema,
 * internal identifiers or stack traces reach the UI (Phase 9E-3D-3 §4).
 */
class AdjustError extends Error {}

function toActionError(err: unknown, context: string, generic: string): InventoryActionState {
  if (err instanceof AdjustError) return { error: err.message };
  console.error(`[${context}] unexpected error`, err);
  return { error: generic };
}

const adjustSchema = z.object({
  variantId: z.string().min(1),
  mode: z.enum(["increase", "decrease", "set"]),
  amount: z.number().int().min(0, "Enter a whole number ≥ 0").max(1_000_000, "Too large"),
  reason: z.string().min(1, "Choose a reason").max(40),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

function revalidate() {
  revalidateTag("products", "max"); // storefront availability changed
  revalidatePath("/admin/inventory");
  revalidatePath("/admin/inventory/history");
}

export async function adjustStockAction(
  _prev: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const admin = await requirePermission("manage_inventory");

  const parsed = adjustSchema.safeParse({
    variantId: String(formData.get("variantId") ?? ""),
    mode: String(formData.get("mode") ?? ""),
    amount: Number(formData.get("amount") ?? NaN),
    reason: String(formData.get("reason") ?? ""),
    note: String(formData.get("note") ?? ""),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const i of parsed.error.issues) {
      const k = i.path[0] != null ? String(i.path[0]) : "_";
      if (!fieldErrors[k]) fieldErrors[k] = i.message;
    }
    return { error: "Please fix the highlighted fields.", fieldErrors };
  }
  const { variantId, mode, amount, reason, note } = parsed.data;

  // Phase 9E-3D-3: preload the current quantity from the operational authority
  // (the Axiaro FIRST_PARTY OfferInventory), not the legacy Inventory mirror.
  const inv = await getFirstPartyStock(variantId);
  if (!inv) return { error: "No inventory record for that variant." };

  let delta: number;
  let auditAction: string;
  if (mode === "set") {
    delta = amount - inv.quantity;
    auditAction = "inventory.stock_corrected";
  } else {
    delta = mode === "increase" ? amount : -amount;
    auditAction = "inventory.stock_adjusted";
  }

  if (delta === 0) {
    return { ok: true, message: "No change — quantity already at that value." };
  }

  const effectiveReason = mode === "set" ? "CORRECTION" : reason;
  // Phase 9D-D + 9E-3D-1: the 1P `OfferInventory` sync AND the legacy `Inventory`
  // mutation run in ONE transaction — both move by the same delta or neither
  // does. LOCK ORDER (9E-3D-1 §12/§14): OfferInventory is locked FIRST (via
  // `syncFirstPartyOfferStock`'s `FOR UPDATE OF oi`), then `Inventory` (via
  // `adjustStock`), matching checkout / cancel / return. `adjustStock` keeps
  // its own row-lock / InventoryAdjustment / Variant.stock-mirror behaviour.
  let result: Awaited<ReturnType<typeof adjustStock>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      try {
        await syncFirstPartyOfferStock(variantId, delta, effectiveReason, note || null, admin.user.id, tx);
      } catch (syncErr) {
        // Internal invariant / DB error from the offer mirror sync — log the
        // detail server-side, surface a sanitized message (§4).
        console.error("[adjustStockAction] OfferInventory sync failed for variant", variantId, syncErr);
        throw new AdjustError(
          "Couldn’t adjust stock — the stored figures need a refresh. Reload the page and try again.",
        );
      }
      const r = await adjustStock(
        { variantId, delta, reason: effectiveReason, note: note || null, actorUserId: admin.user.id },
        tx,
      );
      // `adjustStock` returns { ok: false } (user-facing copy) without throwing
      // on an invariant violation — re-throw it as an AdjustError so the
      // OfferInventory write above rolls back too and the message passes through.
      if (!r.ok) throw new AdjustError(r.error ?? "Adjustment failed.");
      return r;
    });
  } catch (err) {
    return toActionError(err, "adjustStockAction", "Couldn’t adjust stock right now. Please try again.");
  }
  if (!result.ok) return { error: result.error ?? "Adjustment failed." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: auditAction,
    targetType: "variant",
    targetId: variantId,
    summary: `${admin.user.email} ${mode === "set" ? "corrected" : "adjusted"} stock for “${inv.productName}” (${result.previousQuantity} → ${result.newQuantity})`,
    meta: {
      previousQuantity: result.previousQuantity,
      newQuantity: result.newQuantity,
      delta,
      reason: effectiveReason,
      reserved: result.reserved,
    },
  });

  revalidate();
  return {
    ok: true,
    message: `Stock ${mode === "set" ? "corrected to" : mode === "increase" ? "increased to" : "reduced to"} ${result.newQuantity}.`,
  };
}

const thresholdSchema = z.object({
  variantId: z.string().min(1),
  reorderPoint: z.number().int().min(0, "Must be ≥ 0").max(100_000, "Too large"),
});

export async function updateThresholdAction(
  _prev: InventoryActionState,
  formData: FormData,
): Promise<InventoryActionState> {
  const admin = await requirePermission("manage_inventory");

  const parsed = thresholdSchema.safeParse({
    variantId: String(formData.get("variantId") ?? ""),
    reorderPoint: Number(formData.get("reorderPoint") ?? NaN),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid threshold." };
  }
  const { variantId, reorderPoint } = parsed.data;

  // Phase 9E-3D-3: preload from the operational authority, not the mirror.
  const inv = await getFirstPartyStock(variantId);
  if (!inv) return { error: "No inventory record for that variant." };

  // Phase 9D-D + 9E-3D-1: OfferInventory.reorderPoint AND Inventory.reorderPoint
  // move together, atomically. OfferInventory first (§12 lock-order convention;
  // neither call takes a `FOR UPDATE` row lock here — a threshold change is not
  // a quantity change — so the ordering is for consistency, not deadlock).
  let result: Awaited<ReturnType<typeof setReorderPoint>>;
  try {
    result = await prisma.$transaction(async (tx) => {
      try {
        await syncFirstPartyOfferReorderPoint(variantId, reorderPoint, tx);
      } catch (syncErr) {
        console.error("[updateThresholdAction] OfferInventory reorder-point sync failed for variant", variantId, syncErr);
        throw new AdjustError("Couldn’t update the threshold — please reload the page and try again.");
      }
      const r = await setReorderPoint(variantId, reorderPoint, tx);
      if (!r.ok) throw new AdjustError(r.error ?? "Could not update the threshold.");
      return r;
    });
  } catch (err) {
    return toActionError(err, "updateThresholdAction", "Couldn’t update the threshold right now. Please try again.");
  }
  if (!result.ok) return { error: result.error ?? "Could not update the threshold." };
  if (result.previous === reorderPoint) return { ok: true, message: "Threshold unchanged." };

  await writeAudit({
    actorUserId: admin.user.id,
    action: "inventory.threshold_updated",
    targetType: "variant",
    targetId: variantId,
    summary: `${admin.user.email} set the low-stock threshold for “${inv.productName}” to ${reorderPoint}`,
    meta: { previous: result.previous, reorderPoint },
  });

  revalidate();
  return { ok: true, message: `Low-stock threshold set to ${reorderPoint}.` };
}
