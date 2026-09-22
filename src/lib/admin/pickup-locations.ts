import "server-only";
import { prisma } from "@/lib/prisma";

/**
 * Admin read layer for Axiaro-owned Store Pickup locations (Phase 9F-49 CMS
 * step). Mirrors `src/lib/admin/shipping.ts` (the ShippingMethod admin read
 * layer) exactly. Uncached — admins see live data.
 *
 * Scoped to `sellerId: null` only — seller-owned pickup locations are a
 * later, separate feature (not built here; see the schema-foundation task's
 * design notes). This module never reads or writes a seller-owned row.
 */

export type AdminPickupLocation = {
  id: string;
  name: string;
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  instructions: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: string;
};

function toDTO(row: {
  id: string;
  name: string;
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  instructions: string | null;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}): AdminPickupLocation {
  return {
    id: row.id,
    name: row.name,
    recipient: row.recipient,
    phone: row.phone,
    line1: row.line1,
    line2: row.line2,
    barangay: row.barangay,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    country: row.country,
    instructions: row.instructions,
    active: row.active,
    sortOrder: row.sortOrder,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAxiaroPickupLocations(): Promise<AdminPickupLocation[]> {
  const rows = await prisma.pickupLocation.findMany({
    where: { sellerId: null },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map(toDTO);
}

/** `null` for a missing row OR a seller-owned one — this admin surface never touches those. */
export async function getAxiaroPickupLocation(id: string): Promise<AdminPickupLocation | null> {
  const row = await prisma.pickupLocation.findFirst({ where: { id, sellerId: null } });
  return row ? toDTO(row) : null;
}
