"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { COUNTRY_CODES, DEFAULT_COUNTRY, getCountry } from "@/lib/countries";

/**
 * Axiaro-owned Store Pickup location CMS (Phase 9F-49 CMS step). Uses the
 * existing `manage_shipping` RBAC permission — no new permission introduced,
 * same as `shipping-actions.ts`. Every mutation is permission-checked,
 * validated server-side, and audited.
 *
 * `sellerId` is NEVER read from the form — every row this module creates or
 * updates is hardcoded to `sellerId: null` (Axiaro-owned). Seller-owned
 * pickup locations are a separate, later feature; this admin surface cannot
 * create or edit one even if a caller tried to pass a sellerId, because the
 * field simply isn't part of the schema or the Prisma calls below.
 *
 * Not wired into checkout, `ShippingMethod`, or order creation — this is a
 * standalone CMS for the location data itself.
 */

export type PickupLocationActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
};

// Same phone/postal-pattern-per-country validation used by the customer
// address book (`addressInputSchema` in `src/lib/addresses.ts`) and the
// seller origin/return address forms (`origin-address.ts` / `return-destination.ts`).
const baseSchema = z
  .object({
    name: z.string().trim().min(2, "Name is required").max(80),
    recipient: z.string().trim().min(2, "Recipient is required").max(120),
    phone: z.string().trim().min(6, "Enter a phone number").max(30),
    line1: z.string().trim().min(3, "Enter the street address").max(160),
    line2: z.string().trim().max(160).optional().or(z.literal("")),
    barangay: z.string().trim().max(80).optional().or(z.literal("")),
    city: z.string().trim().min(2, "Enter the city or municipality").max(80),
    province: z.string().trim().min(2, "Enter the province / region").max(80),
    postalCode: z.string().trim().min(3, "Enter a postal code").max(12),
    country: z.enum(COUNTRY_CODES).default(DEFAULT_COUNTRY),
    instructions: z.string().trim().max(300).optional().or(z.literal("")),
    active: z.coerce.boolean().default(true),
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
  })
  .superRefine((val, ctx) => {
    const country = getCountry(val.country);
    if (!country) return;
    if (!country.phonePattern.test(val.phone)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["phone"], message: "That phone number doesn’t look right." });
    }
    if (!country.postalPattern.test(val.postalCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postalCode"],
        message: `That postal code doesn’t look right for ${country.name}.`,
      });
    }
  });

function fieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path[0] != null ? String(i.path[0]) : "_";
    if (!out[k]) out[k] = i.message;
  }
  return out;
}

function readForm(fd: FormData) {
  return {
    name: String(fd.get("name") ?? ""),
    recipient: String(fd.get("recipient") ?? ""),
    phone: String(fd.get("phone") ?? ""),
    line1: String(fd.get("line1") ?? ""),
    line2: String(fd.get("line2") ?? ""),
    barangay: String(fd.get("barangay") ?? ""),
    city: String(fd.get("city") ?? ""),
    province: String(fd.get("province") ?? ""),
    postalCode: String(fd.get("postalCode") ?? ""),
    country: String(fd.get("country") ?? DEFAULT_COUNTRY),
    instructions: String(fd.get("instructions") ?? ""),
    active: fd.get("active") === "on" || fd.get("active") === "true",
    sortOrder: String(fd.get("sortOrder") ?? "0"),
  };
}

export async function createPickupLocationAction(
  _prev: PickupLocationActionState,
  formData: FormData,
): Promise<PickupLocationActionState> {
  const admin = await requirePermission("manage_shipping");
  const parsed = baseSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  const d = parsed.data;

  const created = await prisma.pickupLocation.create({
    data: {
      // Never read from the form — this CMS only ever creates Axiaro-owned rows.
      sellerId: null,
      name: d.name,
      recipient: d.recipient,
      phone: d.phone,
      line1: d.line1,
      line2: d.line2 || null,
      barangay: d.barangay || null,
      city: d.city,
      province: d.province,
      postalCode: d.postalCode,
      country: d.country,
      instructions: d.instructions || null,
      active: d.active,
      sortOrder: d.sortOrder,
    },
    select: { id: true, name: true },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "pickup_location.created",
    targetType: "pickup_location",
    targetId: created.id,
    summary: `${admin.user.email} created pickup location “${created.name}”`,
    meta: { name: created.name },
  });

  revalidatePath("/admin/shipping");
  return { ok: true };
}

export async function updatePickupLocationAction(
  _prev: PickupLocationActionState,
  formData: FormData,
): Promise<PickupLocationActionState> {
  const admin = await requirePermission("manage_shipping");
  const id = String(formData.get("id") ?? "");
  // Scoped to sellerId: null — this admin surface can never touch a seller-owned row.
  const current = await prisma.pickupLocation.findFirst({ where: { id, sellerId: null } });
  if (!current) return { ok: false, error: "That pickup location wasn’t found." };

  const parsed = baseSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  const d = parsed.data;

  await prisma.pickupLocation.update({
    where: { id },
    data: {
      name: d.name,
      recipient: d.recipient,
      phone: d.phone,
      line1: d.line1,
      line2: d.line2 || null,
      barangay: d.barangay || null,
      city: d.city,
      province: d.province,
      postalCode: d.postalCode,
      country: d.country,
      instructions: d.instructions || null,
      active: d.active,
      sortOrder: d.sortOrder,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "pickup_location.updated",
    targetType: "pickup_location",
    targetId: id,
    summary: `${admin.user.email} updated pickup location “${d.name}”`,
    meta: { activeBefore: current.active, activeAfter: d.active },
  });

  revalidatePath("/admin/shipping");
  return { ok: true };
}

const toggleSchema = z.object({ id: z.string().min(1), active: z.boolean() });

export async function setPickupLocationActiveAction(input: unknown): Promise<PickupLocationActionState> {
  const admin = await requirePermission("manage_shipping");
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.pickupLocation.findFirst({ where: { id: parsed.data.id, sellerId: null } });
  if (!current) return { ok: false, error: "That pickup location wasn’t found." };

  await prisma.pickupLocation.update({
    where: { id: parsed.data.id },
    data: { active: parsed.data.active },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "pickup_location.updated",
    targetType: "pickup_location",
    targetId: parsed.data.id,
    summary: `${admin.user.email} ${parsed.data.active ? "activated" : "deactivated"} pickup location “${current.name}”`,
    meta: { activeBefore: current.active, activeAfter: parsed.data.active },
  });

  revalidatePath("/admin/shipping");
  return { ok: true };
}
