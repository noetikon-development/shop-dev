"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { normalizeCouponCode, COUPON_CODE_RE } from "@/lib/coupons";

/**
 * Coupon administration (Step 14). Uses the existing `view_coupons` /
 * `manage_coupons` RBAC permissions — no new permission. Every mutation is
 * permission-checked, validated server-side and audited. The code is normalised
 * to its canonical UPPERCASE form here — the client value is never trusted.
 */

export type CouponActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  createdId?: string;
};

const pesosToCentavos = (v: number) => Math.round(v * 100);

/** Shared field parsing. Empty form fields arrive as `undefined` (see readForm).
 *  `value` is a % for PERCENT, ₱ for FIXED; the money fields are ₱. */
const optionalPesos = z.coerce.number().min(0).max(10_000_000).optional();
const optionalCount = (max: number) => z.coerce.number().int().min(1).max(max).optional();

const baseObject = z.object({
  description: z.string().trim().max(200).optional(),
  type: z.enum(["PERCENT", "FIXED"]),
  valueRaw: z.coerce.number("Enter a discount value").positive("Must be greater than 0"),
  maxDiscountPesos: optionalPesos,
  minSubtotalPesos: optionalPesos,
  startsAt: z.string().trim().max(40).optional(),
  expiresAt: z.string().trim().max(40).optional(),
  usageLimit: optionalCount(1_000_000),
  perCustomerLimit: optionalCount(1000),
  active: z.coerce.boolean().default(false),
});

const refine = (d: z.infer<typeof baseObject>, ctx: z.RefinementCtx) => {
  if (d.type === "PERCENT" && (d.valueRaw < 1 || d.valueRaw > 100)) {
    ctx.addIssue({ code: "custom", path: ["valueRaw"], message: "A percentage must be 1–100." });
  }
  if (d.type === "FIXED" && d.valueRaw > 100_000) {
    ctx.addIssue({ code: "custom", path: ["valueRaw"], message: "Too large." });
  }
  const s = d.startsAt ? new Date(d.startsAt) : null;
  const e = d.expiresAt ? new Date(d.expiresAt) : null;
  if (s && Number.isNaN(s.getTime())) ctx.addIssue({ code: "custom", path: ["startsAt"], message: "Invalid date." });
  if (e && Number.isNaN(e.getTime())) ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "Invalid date." });
  if (s && e && !Number.isNaN(s.getTime()) && !Number.isNaN(e.getTime()) && e <= s) {
    ctx.addIssue({ code: "custom", path: ["expiresAt"], message: "The end date must be after the start date." });
  }
};

const baseSchema = baseObject.superRefine(refine);
const createSchema = baseObject.extend({ code: z.string().trim().min(1).max(32) }).superRefine(refine);

function fieldErrors(issues: readonly { path: readonly PropertyKey[]; message: string }[]) {
  const out: Record<string, string> = {};
  for (const i of issues) {
    const k = i.path[0] != null ? String(i.path[0]) : "_";
    if (!out[k]) out[k] = i.message;
  }
  // Map internal field names → form input names.
  if (out.valueRaw) out.value = out.valueRaw;
  if (out.maxDiscountPesos) out.maxDiscount = out.maxDiscountPesos;
  if (out.minSubtotalPesos) out.minSubtotal = out.minSubtotalPesos;
  return out;
}

function readForm(fd: FormData) {
  const opt = (k: string) => {
    const raw = String(fd.get(k) ?? "").trim();
    return raw === "" ? undefined : raw;
  };
  return {
    code: String(fd.get("code") ?? ""),
    description: opt("description"),
    type: String(fd.get("type") ?? "PERCENT"),
    valueRaw: opt("value"),
    maxDiscountPesos: opt("maxDiscount"),
    minSubtotalPesos: opt("minSubtotal"),
    startsAt: opt("startsAt"),
    expiresAt: opt("expiresAt"),
    usageLimit: opt("usageLimit"),
    perCustomerLimit: opt("perCustomerLimit"),
    active: fd.get("active") === "on" || fd.get("active") === "true",
  };
}

type Parsed = z.infer<typeof baseObject>;

function toData(d: Parsed) {
  const value = d.type === "PERCENT" ? Math.round(d.valueRaw) : pesosToCentavos(d.valueRaw);
  return {
    description: d.description || null,
    type: d.type,
    value,
    maxDiscount:
      d.type === "PERCENT" && d.maxDiscountPesos != null ? pesosToCentavos(d.maxDiscountPesos) : null,
    minSubtotal: d.minSubtotalPesos != null ? pesosToCentavos(d.minSubtotalPesos) : 0,
    startsAt: d.startsAt ? new Date(d.startsAt) : null,
    expiresAt: d.expiresAt ? new Date(d.expiresAt) : null,
    usageLimit: d.usageLimit ?? null,
    perCustomerLimit: d.perCustomerLimit ?? null,
    active: d.active,
  };
}

function revalidate(id?: string) {
  revalidatePath("/admin/marketing/coupons");
  if (id) revalidatePath(`/admin/marketing/coupons/${id}`);
  revalidatePath("/promotions");
  revalidatePath("/cart");
  revalidatePath("/checkout");
}

export async function createCouponAction(
  _prev: CouponActionState,
  formData: FormData,
): Promise<CouponActionState> {
  const admin = await requirePermission("manage_coupons");

  const parsed = createSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }
  const code = normalizeCouponCode(parsed.data.code);
  if (!COUPON_CODE_RE.test(code)) {
    return { ok: false, error: "Invalid code.", fieldErrors: { code: "Use 3–24 letters or digits." } };
  }
  const exists = await prisma.coupon.findUnique({ where: { code }, select: { id: true } });
  if (exists) return { ok: false, error: "That code is already in use.", fieldErrors: { code: "Already in use" } };

  const created = await prisma.coupon.create({
    data: { code, ...toData(parsed.data) },
    select: { id: true, code: true, type: true, value: true },
  });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "coupon.created",
    targetType: "coupon",
    targetId: created.id,
    summary: `${admin.user.email} created coupon ${created.code} (${created.type} ${created.value})`,
    meta: { code: created.code, type: created.type, value: created.value },
  });

  revalidate(created.id);
  return { ok: true, createdId: created.id };
}

export async function updateCouponAction(
  _prev: CouponActionState,
  formData: FormData,
): Promise<CouponActionState> {
  const admin = await requirePermission("manage_coupons");

  const id = String(formData.get("id") ?? "");
  const current = await prisma.coupon.findUnique({ where: { id } });
  if (!current) return { ok: false, error: "That coupon wasn’t found." };

  const parsed = baseSchema.safeParse(readForm(formData));
  if (!parsed.success) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors: fieldErrors(parsed.error.issues) };
  }

  const data = toData(parsed.data);
  await prisma.coupon.update({ where: { id }, data });

  await writeAudit({
    actorUserId: admin.user.id,
    action: "coupon.updated",
    targetType: "coupon",
    targetId: id,
    summary: `${admin.user.email} updated coupon ${current.code}`,
    meta: {
      code: current.code,
      before: { type: current.type, value: current.value, active: current.active },
      after: { type: data.type, value: data.value, active: data.active },
    },
  });

  revalidate(id);
  return { ok: true };
}

const toggleSchema = z.object({ id: z.string().min(1).max(64), active: z.boolean() });

export async function setCouponActiveAction(input: unknown): Promise<CouponActionState> {
  const admin = await requirePermission("manage_coupons");
  const parsed = toggleSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.coupon.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: false, error: "That coupon wasn’t found." };
  if (current.archivedAt) return { ok: false, error: "Restore the coupon from the archive first." };

  await prisma.coupon.update({ where: { id: parsed.data.id }, data: { active: parsed.data.active } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: parsed.data.active ? "coupon.activated" : "coupon.deactivated",
    targetType: "coupon",
    targetId: parsed.data.id,
    summary: `${admin.user.email} ${parsed.data.active ? "activated" : "deactivated"} coupon ${current.code}`,
    meta: { code: current.code },
  });

  revalidate(parsed.data.id);
  return { ok: true };
}

const idSchema = z.object({ id: z.string().min(1).max(64) });

export async function archiveCouponAction(input: unknown): Promise<CouponActionState> {
  const admin = await requirePermission("manage_coupons");
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.coupon.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: false, error: "That coupon wasn’t found." };
  if (current.archivedAt) return { ok: true };

  await prisma.coupon.update({
    where: { id: parsed.data.id },
    data: { archivedAt: new Date(), active: false },
  });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "coupon.archived",
    targetType: "coupon",
    targetId: parsed.data.id,
    summary: `${admin.user.email} archived coupon ${current.code}`,
    meta: { code: current.code },
  });

  revalidate(parsed.data.id);
  return { ok: true };
}

export async function unarchiveCouponAction(input: unknown): Promise<CouponActionState> {
  const admin = await requirePermission("manage_coupons");
  const parsed = idSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const current = await prisma.coupon.findUnique({ where: { id: parsed.data.id } });
  if (!current) return { ok: false, error: "That coupon wasn’t found." };

  await prisma.coupon.update({ where: { id: parsed.data.id }, data: { archivedAt: null } });
  await writeAudit({
    actorUserId: admin.user.id,
    action: "coupon.unarchived",
    targetType: "coupon",
    targetId: parsed.data.id,
    summary: `${admin.user.email} restored coupon ${current.code} from the archive`,
    meta: { code: current.code },
  });

  revalidate(parsed.data.id);
  return { ok: true };
}
