/**
 * Seeds the site-footer ContentBlock (`footer.default`, area "global", type
 * "footer") from the built-in defaults in src/lib/footer-defaults.ts.
 *
 * Idempotent: creates the block if missing; if it already exists it is left
 * alone (an admin may have edited it) unless --force is passed.
 *
 * Run:  npm run db:seed:footer
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { footerSchema } from "../src/lib/content-blocks";
import { FOOTER_DEFAULTS } from "../src/lib/footer-defaults";

const KEY = "footer.default";

export async function seedFooter(
  prisma: PrismaClient,
  opts: { force?: boolean; log?: (m: string) => void } = {},
) {
  const log = opts.log ?? (() => {});
  const data = JSON.stringify(footerSchema.parse(FOOTER_DEFAULTS));

  const existing = await prisma.contentBlock.findUnique({ where: { key: KEY } });
  if (existing && !opts.force) {
    log(`footer: block already exists (${existing.status}) — left unchanged`);
    return;
  }

  await prisma.contentBlock.upsert({
    where: { key: KEY },
    update: opts.force
      ? { data, type: "footer", area: "global", title: "Footer", status: "PUBLISHED" }
      : {},
    create: {
      key: KEY,
      area: "global",
      type: "footer",
      title: "Footer",
      data,
      position: 0,
      status: "PUBLISHED",
    },
  });
  log(`footer: block ${existing ? "reset" : "created"} (PUBLISHED)`);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedFooter(prisma, { force: process.argv.includes("--force"), log: (m) => console.log(m) })
    .then(() => console.log("Footer seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
