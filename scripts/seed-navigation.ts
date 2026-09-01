/**
 * Seeds the primary-navigation ContentBlock (`nav.primary`, area "global",
 * type "navigation") from the built-in defaults in src/lib/nav-defaults.ts,
 * and — on first run only — converts the footer Shop column from the automatic
 * category fallback into an explicit, editable, category-referenced link list
 * with the same labels and destinations (zero visible change, now editable).
 *
 * Idempotent: the nav block is created if missing and left alone thereafter
 * (an admin may have edited it) unless --force is passed. The footer Shop
 * column is only populated when it is currently empty.
 *
 * Run:  npm run db:seed:nav
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { navSchema, footerSchema } from "../src/lib/content-blocks";
import { NAV_BLOCK_KEY, NAV_DEFAULTS } from "../src/lib/nav-defaults";
import { FOOTER_BLOCK_KEY, FOOTER_DEFAULTS } from "../src/lib/footer-defaults";

/** Root categories that make up the default footer Shop column, in order. */
const FOOTER_SHOP_SLUGS = [
  "living",
  "bedroom",
  "kitchen-dining",
  "textiles",
  "lighting",
  "decor",
  "wardrobe",
];

export async function seedNavigation(
  prisma: PrismaClient,
  opts: { force?: boolean; log?: (m: string) => void } = {},
) {
  const log = opts.log ?? (() => {});

  // --- nav.primary --------------------------------------------------------
  const navData = JSON.stringify(navSchema.parse(NAV_DEFAULTS));
  const existingNav = await prisma.contentBlock.findUnique({ where: { key: NAV_BLOCK_KEY } });
  if (existingNav && !opts.force) {
    log(`navigation: block already exists (${existingNav.status}) — left unchanged`);
  } else {
    await prisma.contentBlock.upsert({
      where: { key: NAV_BLOCK_KEY },
      update: opts.force
        ? { data: navData, type: "navigation", area: "global", title: "Navigation", status: "PUBLISHED" }
        : {},
      create: {
        key: NAV_BLOCK_KEY,
        area: "global",
        type: "navigation",
        title: "Navigation",
        data: navData,
        position: 0,
        status: "PUBLISHED",
      },
    });
    log(`navigation: block ${existingNav ? "reset" : "created"} (PUBLISHED)`);
  }

  // --- footer Shop column -> explicit category-referenced links -----------
  const footerRow = await prisma.contentBlock.findUnique({ where: { key: FOOTER_BLOCK_KEY } });
  const footer = footerRow
    ? footerSchema.parse(JSON.parse(footerRow.data || "{}"))
    : footerSchema.parse(FOOTER_DEFAULTS);

  if (footer.shopColumn.links.length > 0 && !opts.force) {
    log("footer: Shop column already has explicit links — left unchanged");
  } else {
    const cats = await prisma.category.findMany({
      where: { slug: { in: FOOTER_SHOP_SLUGS } },
      select: { name: true, slug: true },
    });
    const bySlug = new Map(cats.map((c) => [c.slug, c.name]));
    const links = [
      ...FOOTER_SHOP_SLUGS.filter((s) => bySlug.has(s)).map((s) => ({
        label: bySlug.get(s)!,
        href: "",
        categorySlug: s,
        enabled: true,
      })),
      { label: "Sale", href: "", categorySlug: "sale", enabled: true },
    ];
    const nextFooter = footerSchema.parse({
      ...footer,
      shopColumn: { ...footer.shopColumn, heading: footer.shopColumn.heading || "Shop", links },
    });
    await prisma.contentBlock.upsert({
      where: { key: FOOTER_BLOCK_KEY },
      update: { data: JSON.stringify(nextFooter), type: "footer", area: "global", title: "Footer", status: "PUBLISHED" },
      create: {
        key: FOOTER_BLOCK_KEY,
        area: "global",
        type: "footer",
        title: "Footer",
        data: JSON.stringify(nextFooter),
        position: 0,
        status: "PUBLISHED",
      },
    });
    log(`footer: Shop column populated with ${links.length} explicit category links`);
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedNavigation(prisma, { force: process.argv.includes("--force"), log: (m) => console.log(m) })
    .then(() => console.log("Navigation seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
