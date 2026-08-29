import "server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { COUNTRY_CODES, DEFAULT_COUNTRY, getCountry } from "@/lib/countries";

/**
 * Customer address book (Step 8). Every function resolves the authenticated
 * customer server-side (Supabase session → Prisma User) and checks ownership of
 * the target address before touching it — the browser never supplies a userId
 * or an ownership claim, and an address id that isn't the caller's is rejected
 * (no IDOR). Default shipping / billing are independent; the DB enforces at
 * most one of each per user via partial unique indexes, the code keeps them
 * consistent by unsetting the previous default in the same transaction.
 */

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export const addressInputSchema = z
  .object({
    label: z.string().trim().min(1, "Add a label").max(40).default("Home"),
    firstName: z.string().trim().min(1, "First name is required").max(60),
    lastName: z.string().trim().min(1, "Last name is required").max(60),
    company: z.string().trim().max(80).optional().or(z.literal("")),
    phone: z.string().trim().min(6, "Enter a phone number").max(30),
    line1: z.string().trim().min(3, "Enter the street address").max(120),
    line2: z.string().trim().max(120).optional().or(z.literal("")),
    barangay: z.string().trim().max(80).optional().or(z.literal("")),
    city: z.string().trim().min(2, "Enter the city or municipality").max(80),
    province: z.string().trim().min(2, "Enter the province / region").max(80),
    region: z.string().trim().max(80).optional().or(z.literal("")),
    postalCode: z.string().trim().min(3, "Enter a postal code").max(12),
    country: z.enum(COUNTRY_CODES).default(DEFAULT_COUNTRY),
    defaultShipping: z.coerce.boolean().default(false),
    defaultBilling: z.coerce.boolean().default(false),
  })
  .superRefine((val, ctx) => {
    const country = getCountry(val.country);
    if (!country) return;
    if (!country.phonePattern.test(val.phone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "That phone number doesn’t look right.",
      });
    }
    if (!country.postalPattern.test(val.postalCode)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postalCode"],
        message: `That postal code doesn’t look right for ${country.name}.`,
      });
    }
  });

export type AddressInput = z.input<typeof addressInputSchema>;

export type FieldErrors = Record<string, string>;

export function zodFieldErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldErrors {
  const out: FieldErrors = {};
  for (const i of issues) {
    const key = i.path[0] != null ? String(i.path[0]) : "_";
    if (!out[key]) out[key] = i.message;
  }
  return out;
}

// ---------------------------------------------------------------------------
// DTO
// ---------------------------------------------------------------------------

export type AddressDTO = {
  id: string;
  label: string;
  firstName: string;
  lastName: string;
  company: string | null;
  phone: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  region: string | null;
  postalCode: string;
  country: string;
  defaultShipping: boolean;
  defaultBilling: boolean;
  createdAt: string;
  updatedAt: string;
};

function toDTO(a: Prisma.AddressGetPayload<object>): AddressDTO {
  return {
    id: a.id,
    label: a.label,
    firstName: a.firstName,
    lastName: a.lastName,
    company: a.company,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    barangay: a.barangay,
    city: a.city,
    province: a.province,
    region: a.region,
    postalCode: a.postalCode,
    country: a.country,
    defaultShipping: a.defaultShipping,
    defaultBilling: a.defaultBilling,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

const listOrder: Prisma.AddressOrderByWithRelationInput[] = [
  { defaultShipping: "desc" },
  { defaultBilling: "desc" },
  { createdAt: "asc" },
];

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type AddressResult =
  | { ok: true; addresses: AddressDTO[] }
  | { ok: false; error: string; status?: 401 | 403 | 404 | 422; fieldErrors?: FieldErrors };

async function requireCustomer(): Promise<
  { ok: true; userId: string } | { ok: false; error: string; status: 401 }
> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, error: "Please sign in to manage your addresses.", status: 401 };
  return { ok: true, userId: user.id };
}

async function listFor(userId: string): Promise<AddressDTO[]> {
  const rows = await prisma.address.findMany({ where: { userId }, orderBy: listOrder });
  return rows.map(toDTO);
}

/** Load the address only if it belongs to this user (no IDOR). */
async function ownedAddress(id: string, userId: string) {
  if (typeof id !== "string" || id.length < 6 || id.length > 64) return null;
  const row = await prisma.address.findUnique({ where: { id } });
  if (!row || row.userId !== userId) return null;
  return row;
}

function fullName(firstName: string, lastName: string) {
  return `${firstName} ${lastName}`.trim();
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getCustomerAddresses(): Promise<AddressDTO[]> {
  const auth = await requireCustomer();
  if (!auth.ok) return [];
  return listFor(auth.userId);
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function createAddress(raw: unknown): Promise<AddressResult> {
  const auth = await requireCustomer();
  if (!auth.ok) return auth;

  const parsed = addressInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please fix the highlighted fields.",
      status: 422,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    };
  }
  const d = parsed.data;

  const existing = await prisma.address.count({ where: { userId: auth.userId } });
  const first = existing === 0;
  const wantShipping = first || d.defaultShipping;
  const wantBilling = first || d.defaultBilling;

  const data: Prisma.AddressCreateInput = {
    user: { connect: { id: auth.userId } },
    label: d.label,
    firstName: d.firstName,
    lastName: d.lastName,
    company: d.company || null,
    phone: d.phone,
    line1: d.line1,
    line2: d.line2 || null,
    barangay: d.barangay || null,
    city: d.city,
    province: d.province,
    region: d.region || null,
    postalCode: d.postalCode,
    country: d.country,
    defaultShipping: wantShipping,
    defaultBilling: wantBilling,
    recipient: fullName(d.firstName, d.lastName),
  };

  await prisma.$transaction(async (tx) => {
    if (wantShipping) {
      await tx.address.updateMany({
        where: { userId: auth.userId, defaultShipping: true },
        data: { defaultShipping: false },
      });
    }
    if (wantBilling) {
      await tx.address.updateMany({
        where: { userId: auth.userId, defaultBilling: true },
        data: { defaultBilling: false },
      });
    }
    await tx.address.create({ data });
  });

  return { ok: true, addresses: await listFor(auth.userId) };
}

export async function updateAddress(id: string, raw: unknown): Promise<AddressResult> {
  const auth = await requireCustomer();
  if (!auth.ok) return auth;

  const current = await ownedAddress(id, auth.userId);
  if (!current) return { ok: false, error: "That address wasn’t found.", status: 404 };

  const parsed = addressInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Please fix the highlighted fields.",
      status: 422,
      fieldErrors: zodFieldErrors(parsed.error.issues),
    };
  }
  const d = parsed.data;

  const turningOnShipping = d.defaultShipping && !current.defaultShipping;
  const turningOnBilling = d.defaultBilling && !current.defaultBilling;

  await prisma.$transaction(async (tx) => {
    if (turningOnShipping) {
      await tx.address.updateMany({
        where: { userId: auth.userId, defaultShipping: true, id: { not: id } },
        data: { defaultShipping: false },
      });
    }
    if (turningOnBilling) {
      await tx.address.updateMany({
        where: { userId: auth.userId, defaultBilling: true, id: { not: id } },
        data: { defaultBilling: false },
      });
    }
    await tx.address.update({
      where: { id },
      data: {
        label: d.label,
        firstName: d.firstName,
        lastName: d.lastName,
        company: d.company || null,
        phone: d.phone,
        line1: d.line1,
        line2: d.line2 || null,
        barangay: d.barangay || null,
        city: d.city,
        province: d.province,
        region: d.region || null,
        postalCode: d.postalCode,
        country: d.country,
        defaultShipping: d.defaultShipping,
        defaultBilling: d.defaultBilling,
        recipient: fullName(d.firstName, d.lastName),
      },
    });
  });

  return { ok: true, addresses: await listFor(auth.userId) };
}

export async function deleteAddress(id: string): Promise<AddressResult> {
  const auth = await requireCustomer();
  if (!auth.ok) return auth;

  const current = await ownedAddress(id, auth.userId);
  if (!current) return { ok: false, error: "That address wasn’t found.", status: 404 };

  // Never destroy historical order information. Orders keep their own address
  // snapshot (Order.shippingAddress), but while the FK link exists we refuse
  // the delete and tell the customer to edit instead.
  const referencing = await prisma.order.count({ where: { addressId: id } });
  if (referencing > 0) {
    return {
      ok: false,
      error:
        "This address is attached to a past order and can’t be deleted. You can edit it instead.",
      status: 422,
    };
  }

  await prisma.$transaction(async (tx) => {
    await tx.address.delete({ where: { id } });

    // If we removed a default, promote the most recent remaining address so the
    // customer always has a usable default when they have any address at all.
    if (current.defaultShipping || current.defaultBilling) {
      const next = await tx.address.findFirst({
        where: { userId: auth.userId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      if (next) {
        await tx.address.update({
          where: { id: next.id },
          data: {
            defaultShipping: current.defaultShipping ? true : undefined,
            defaultBilling: current.defaultBilling ? true : undefined,
          },
        });
      }
    }
  });

  return { ok: true, addresses: await listFor(auth.userId) };
}

async function setDefault(id: string, kind: "shipping" | "billing"): Promise<AddressResult> {
  const auth = await requireCustomer();
  if (!auth.ok) return auth;

  const current = await ownedAddress(id, auth.userId);
  if (!current) return { ok: false, error: "That address wasn’t found.", status: 404 };

  const field = kind === "shipping" ? "defaultShipping" : "defaultBilling";

  await prisma.$transaction(async (tx) => {
    await tx.address.updateMany({
      where: { userId: auth.userId, [field]: true, id: { not: id } },
      data: { [field]: false },
    });
    await tx.address.update({ where: { id }, data: { [field]: true } });
  });

  return { ok: true, addresses: await listFor(auth.userId) };
}

export function setDefaultShippingAddress(id: string) {
  return setDefault(id, "shipping");
}

export function setDefaultBillingAddress(id: string) {
  return setDefault(id, "billing");
}
