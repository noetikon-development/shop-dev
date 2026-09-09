import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decodeSettingValue } from "@/lib/admin/settings-registry";
import { DEFAULT_SELLER_COMMISSION_BPS } from "@/lib/admin/sellers/lifecycle";

/**
 * Global marketplace commission — CMS reader (Phase 9F-39B).
 *
 * The GLOBAL default commission (integer BASIS POINTS) applied to a NEWLY
 * created third-party seller's `Seller.commissionRate`. Configured in
 * Admin → Settings → Marketplace via the generic `StoreSetting` /
 * `SETTINGS_REGISTRY` machinery.
 *
 * Read UNCACHED (safe outside a request scope — same pattern as
 * `getReturnsConfig`) so a CMS change is visible to the next `createSeller`
 * call without a redeploy.
 *
 * This value is used ONLY to seed a new seller's rate. It is NEVER read at
 * checkout, in settlement, or by any refund / return path — existing sellers
 * and historical orders are entirely unaffected by a change here.
 */

type Client = Prisma.TransactionClient | typeof prisma;

export const MARKETPLACE_DEFAULT_COMMISSION_KEY = "marketplace.defaultCommissionBps";

/** CMS-editable range for the global default commission, in basis points. */
export const COMMISSION_BPS_CMS_MIN = 0;
export const COMMISSION_BPS_CMS_MAX = 5000; // 50.00% — the CMS input ceiling
/** Defensive hard ceiling (0%..100%), matches `validateCommissionBps`. */
export const COMMISSION_BPS_HARD_MAX = 10000;

/** True when `raw` is a whole number of basis points inside the CMS range (0–5000). */
export function isValidCmsCommissionBps(raw: unknown): boolean {
  const n = typeof raw === "number" ? raw : Number(String(raw ?? "").trim());
  return (
    String(raw ?? "").trim() !== "" &&
    Number.isInteger(n) &&
    n >= COMMISSION_BPS_CMS_MIN &&
    n <= COMMISSION_BPS_CMS_MAX
  );
}

export async function getDefaultCommissionBps(client: Client = prisma): Promise<number> {
  try {
    const row = await client.storeSetting.findUnique({
      where: { key: MARKETPLACE_DEFAULT_COMMISSION_KEY },
      select: { value: true },
    });
    if (row == null || String(row.value).trim() === "") return DEFAULT_SELLER_COMMISSION_BPS;
    const n = Number(decodeSettingValue(row.value, "number"));
    if (!Number.isInteger(n) || n < COMMISSION_BPS_CMS_MIN || n > COMMISSION_BPS_HARD_MAX) {
      return DEFAULT_SELLER_COMMISSION_BPS;
    }
    // Even a raw row above the CMS ceiling is clamped down — never silently
    // grants a >50% marketplace commission.
    return Math.min(n, COMMISSION_BPS_CMS_MAX);
  } catch {
    return DEFAULT_SELLER_COMMISSION_BPS;
  }
}
