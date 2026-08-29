"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";

/**
 * Shipping method configuration (Step 11). Uses the existing `manage_shipping`
 * RBAC permission — no new permission introduced. Every mutation is
 * permission-checked, validated server-side, and audited.
 */

export type ShippingActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
};

const SUPPORTED_CURRENCIES = ["PHP"] as const;

const baseSchema = z.object({
  name: z.string().trim().min(2, "Name is required").max(60),
  description: z.string().trim().max(200).optional().or(z.literal("")),
  // Rate entered in whole pesos in the form; converted to centavos here.
  ratePesos: z.coerce.number("Enter a rate").min(0, "Rate can’t be negative").max(100000),
  currency: z.enum(SUPPORTED_CURRENCIES),
  active: z.coerce.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(999).default(0),
});

const createSchema = baseSchema.extend({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_]{2,20}$/, "Use 2–20 uppercase letters, numbers or underscores"),
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
    code: String(fd.get("code") ?? ""),
    name: String(fd.get("name") ?? ""),
    description: String(fd.get("description") ?? ""),
    ratePesos: String(fd.get("ratePesos") ?? ""),
    currency: String(fd.get("currency") ?? "PHP"),
    active: fd.get("active") === "on" || fd.get("active") === "true",
    sortOrder: String(fd.get("sortOrder") ?? "0"),
  };
}

export async function createShippingMethodAction(
  _prev: ShippingActionState,
  formData: FormData,
): Promise<ShippingActionState> {
  const admin = await requirePermission("manage_shipping");
  const parsed = createSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  const d = parsed.data;

  const exists = await prisma.shippingMethod.findUnique({ where: { code: d.code }, select: { id: true } });
  if (exists) return { ok: false, error: "A method with that code already exists.", fieldErrors: { code: "Already in use" } };

  const created = await prisma.shippingMethod.create({
    data: {
      code: d.code,
      name: d.name,
      description: d.description || null,
      rate: Math.round(d.ratePesos * 100),
      currency: d.currency,
      active: d.active,
      sortOrder: d.sortOrder,
    },
    select: { id: true, code: true, name: true, rate: true },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "shipping.method_created",
    targetType: "shipping_method",
    targetId: created.id,
    summary: `${admin.user.email} created shipping method “${created.name}” (${created.code}) at ${created.rate} centavos`,
    meta: { code: created.code, rate: created.rate },
  });

  revalidatePath("/admin/shipping");
  revalidatePath("/checkout");
  return { ok: true };
}

export async function updateShippingMethodAction(
  _prev: ShippingActionState,
  formData: FormData,
): Promise<ShippingActionState> {
  const admin = await requirePermission("manage_shipping");
  const id = String(formData.get("id") ?? "");
  const current = await prisma.shippingMethod.findUnique({ where: { id } });
  if (!current) return { ok: false, error: "That shipping method wasn’t found." };

  const parsed = baseSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  const d = parsed.data;
  const newRate = Math.round(d.ratePesos * 100);

  await prisma.shippingMethod.update({
    where: { id },
    data: {
      name: d.name,
      description: d.description || null,
      rate: newRate,
      currency: d.currency,
      active: d.active,
      sortOrder: d.sortOrder,
    },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "shipping.method_updated",
    targetType: "shipping_method",
    targetId: id,
    summary: `${admin.user.email} updated shipping method “${d.name}” (${current.code})`,
    meta: {
      code: current.code,
      rateBefore: current.rate,
      rateAfter: newRate,
      activeBefore: current.active,
      activeAfter: d.active,
    },
  });

  revalidatePath("/admin/shipping");
  revalidatePath("/checkout");
  return { ok: true };
}

const toggleSchema = z.object({ id: z.string().min(1), active: z.boolean() });

export async function setShippingMethodActiveAction(input: unknown): Promise<ShippingActionState> {
  const admin = await requirePermission("manage_shipping");
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.shippingMethod.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: false, error: "That shipping method wasn’t found." };

  await prisma.shippingMethod.update({
    where: { id: parsed.data.id },
    data: { active: parsed.data.active },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "shipping.method_updated",
    targetType: "shipping_method",
    targetId: parsed.data.id,
    summary: `${admin.user.email} ${parsed.data.active ? "activated" : "deactivated"} shipping method “${current.name}” (${current.code})`,
    meta: { code: current.code, activeBefore: current.active, activeAfter: parsed.data.active },
  });

  revalidatePath("/admin/shipping");
  revalidatePath("/checkout");
  return { ok: true };
}
