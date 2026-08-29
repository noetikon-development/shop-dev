import "server-only";
import { prisma } from "@/lib/prisma";

/** Admin read layer for shipping methods (Step 11). Uncached — admins see live data. */

export type AdminShippingMethod = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  rate: number; // centavos
  currency: string;
  active: boolean;
  sortOrder: number;
  orderCount: number;
  updatedAt: string;
};

export async function listShippingMethods(): Promise<AdminShippingMethod[]> {
  const rows = await prisma.shippingMethod.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    include: { _count: { select: { orders: true } } },
  });
  return rows.map((m) => ({
    id: m.id,
    code: m.code,
    name: m.name,
    description: m.description,
    rate: m.rate,
    currency: m.currency,
    active: m.active,
    sortOrder: m.sortOrder,
    orderCount: m._count.orders,
    updatedAt: m.updatedAt.toISOString(),
  }));
}

export async function getShippingMethod(id: string) {
  return prisma.shippingMethod.findUnique({ where: { id } });
}
