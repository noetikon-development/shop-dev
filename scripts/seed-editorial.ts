/**
 * Seeds the homepage "editorial statement" ContentBlock (Phase 5D Stage 5) —
 * one quiet full-width line between the feature cards and the bestsellers grid,
 * as a rhythmic pause in the product-led homepage.
 *
 * The block uses the existing `ContentBlock` model (type "editorial", area
 * "homepage"). NO new table. Its copy is a restatement of the store's own
 * standing positioning ("designed in-house", "made to last" — both already in
 * the CMS hero block and the value props); it contains no prices, thresholds
 * or offers. The admin can edit or remove it from Admin → Content → Homepage.
 *
 * Also normalises the homepage block `position` values so the new block slots
 * in cleanly (0..7). Idempotent: skips if the block already exists unless
 * --force is passed.
 *
 * Run:  npm run db:seed:editorial
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { editorialSchema } from "../src/lib/content-blocks";

const KEY = "homepage.editorial.default";

/** Desired homepage order, by block key. Any homepage block not listed keeps
 *  its relative order after these. */
const ORDER = [
  "homepage.hero.default",
  "homepage.categories.default",
  "homepage.rail.new",
  "homepage.features.default",
  KEY,
  "homepage.rail.bestsellers",
  "homepage.valueprops.default",
  "homepage.rail.sale",
];

const EDITORIAL = editorialSchema.parse({
  eyebrow: "",
  heading: "Designed in-house, and made to last.",
  body: "",
});

export async function seedEditorial(
  prisma: PrismaClient,
  opts: { force?: boolean; log?: (m: string) => void } = {},
) {
  const log = opts.log ?? (() => {});
  const data = JSON.stringify(EDITORIAL);

  const existing = await prisma.contentBlock.findUnique({ where: { key: KEY } });
  if (existing && !opts.force) {
    log(`editorial: block already exists (${existing.status}) — left unchanged`);
  } else {
    await prisma.contentBlock.upsert({
      where: { key: KEY },
      update: opts.force
        ? { data, type: "editorial", area: "homepage", title: "Editorial statement", status: "PUBLISHED" }
        : {},
      create: {
        key: KEY,
        area: "homepage",
        type: "editorial",
        title: "Editorial statement",
        data,
        position: 4,
        status: "PUBLISHED",
      },
    });
    log(`editorial: block ${existing ? "reset" : "created"} (PUBLISHED)`);
  }

  // Normalise positions.
  const blocks = await prisma.contentBlock.findMany({
    where: { area: "homepage" },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { id: true, key: true, position: true },
  });
  const rank = (key: string) => {
    const i = ORDER.indexOf(key);
    return i === -1 ? ORDER.length : i;
  };
  const ordered = [...blocks].sort((a, b) => rank(a.key) - rank(b.key) || a.position - b.position);
  const updates = ordered
    .map((b, i) => ({ id: b.id, key: b.key, from: b.position, to: i }))
    .filter((u) => u.from !== u.to);

  if (updates.length) {
    await prisma.$transaction(
      updates.map((u) => prisma.contentBlock.update({ where: { id: u.id }, data: { position: u.to } })),
    );
    log(`homepage positions normalised: ${updates.map((u) => `${u.key} ${u.from}→${u.to}`).join(", ")}`);
  } else {
    log("homepage positions already in order");
  }
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedEditorial(prisma, { force: process.argv.includes("--force"), log: (m) => console.log(m) })
    .then(() => console.log("Editorial seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
