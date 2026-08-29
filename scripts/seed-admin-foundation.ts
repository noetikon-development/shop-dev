/**
 * Seeds the Step 4 Admin Panel / CMS foundation:
 *   - StoreSetting rows for every key in the settings registry (non-destructive:
 *     existing values are preserved, only metadata is refreshed).
 *
 * Values here are SEED DATA, not application logic — a different brand ships by
 * changing them. Run:  npm run db:seed:settings
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import {
  SETTINGS_REGISTRY,
  encodeSettingValue,
} from "../src/lib/admin/settings-registry";
import { SITE } from "../src/lib/constants";

// Initial values for a fresh install. Anything not listed uses the registry
// default. This block is the ONLY place brand-specific strings live.
const INITIAL: Record<string, unknown> = {
  "store.name": SITE.name,
  "store.brand": SITE.brand,
  "store.tagline": SITE.tagline,
  "store.description": SITE.description,
  "seo.defaultTitle": `${SITE.brand} — ${SITE.tagline}`,
  "seo.defaultDescription": SITE.description,
  "seo.titleTemplate": `%s · ${SITE.brand}`,
  "contact.country": "Philippines",
};

export async function seedAdminFoundation(
  prisma: PrismaClient,
  log: (message: string) => void = () => {},
) {
  let created = 0;
  for (const field of SETTINGS_REGISTRY) {
    const initial = field.key in INITIAL ? INITIAL[field.key] : field.default;
    const value = encodeSettingValue(initial, field.type);
    const existing = await prisma.storeSetting.findUnique({ where: { key: field.key } });
    if (existing) {
      await prisma.storeSetting.update({
        where: { key: field.key },
        data: { type: field.type, label: field.label, group: `settings:${field.group}` },
      });
    } else {
      await prisma.storeSetting.create({
        data: {
          key: field.key,
          value,
          type: field.type,
          label: field.label,
          group: `settings:${field.group}`,
        },
      });
      created++;
    }
  }
  log(`settings: ${SETTINGS_REGISTRY.length} registered (${created} created)`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedAdminFoundation(prisma, (m) => console.log(m))
    .then(() => console.log("Admin foundation seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
