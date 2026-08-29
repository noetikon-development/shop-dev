import "server-only";
import { prisma } from "@/lib/prisma";
import {
  SETTINGS_REGISTRY,
  decodeSettingValue,
} from "@/lib/admin/settings-registry";

export * from "@/lib/admin/settings-registry";

const REGISTRY_KEYS = new Set(SETTINGS_REGISTRY.map((f) => f.key));

/**
 * All settings as a { key: value } map with registry defaults filled in.
 * Server-only — reads the `StoreSetting` table.
 */
export async function getStoreSettings(): Promise<Record<string, unknown>> {
  const rows = await prisma.storeSetting.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const out: Record<string, unknown> = {};
  for (const field of SETTINGS_REGISTRY) {
    const row = byKey.get(field.key);
    out[field.key] = row
      ? decodeSettingValue(row.value, field.type)
      : field.default;
  }
  return out;
}

export function isRegisteredSetting(key: string): boolean {
  return REGISTRY_KEYS.has(key);
}
