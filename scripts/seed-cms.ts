/**
 * Seeds the Step 16 CMS content:
 *   - homepage ContentBlocks that reproduce the built-in homepage (so it
 *     looks identical but is now editable in /admin/content/homepage);
 *   - core informational ContentPages (Assembly & care, Cookie policy). The
 *     legal / policy pages live in scripts/seed-legal-content.ts.
 *
 * The copy reflects what the store can actually do today. It is general
 * information, not legal advice — a real launch should have the policy pages
 * reviewed by a qualified professional.
 *
 * NON-DESTRUCTIVE: rows are created only if missing (matched by key / slug).
 * Existing rows — including admin edits — are left untouched. Run:
 *   npm run db:seed:cms
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";
import { seedLegalContent } from "./seed-legal-content";

type BlockSeed = {
  key: string;
  type: string;
  title: string;
  position: number;
  data: Record<string, unknown>;
};

const HOMEPAGE_BLOCKS: BlockSeed[] = [
  {
    key: "homepage.hero.default",
    type: "hero",
    title: "Hero",
    position: 0,
    data: {
      eyebrow: "New in",
      heading: "Considered things for everyday living",
      body: "Everything for everyday living.",
      ctaLabel: "Shop everything",
      ctaHref: "/c/all",
      secondaryCtaLabel: "See what's new",
      secondaryCtaHref: "/c/new",
      imageMediaId: "",
      notes: ["Free standard shipping", "Easy returns", "Helpful support"],
    },
  },
  { key: "homepage.categories.default", type: "category_tiles", title: "Category tiles", position: 1, data: { heading: "" } },
  {
    key: "homepage.rail.new",
    type: "product_rail",
    title: "New this season",
    position: 2,
    data: {
      eyebrow: "Just landed",
      title: "New this season",
      source: "new_arrivals",
      categorySlug: "",
      productIds: [],
      actionLabel: "View all new",
      actionHref: "/c/new",
      limit: 10,
    },
  },
  {
    key: "homepage.features.default",
    type: "feature_grid",
    title: "Feature cards",
    position: 3,
    data: {
      items: [
        {
          eyebrow: "The washable sofa",
          title: "Aro, now in four new weaves",
          body: "Every cover unzips and goes in the machine. Spills, pets, kids — all fine.",
          ctaLabel: "Meet the Aro",
          href: "/p/aro-3-seat-sofa",
          imageMediaId: "",
        },
        {
          eyebrow: "Wardrobe, edited",
          title: "The pieces you actually reach for",
          body: "A tight rotation of organic-cotton shirts, lambswool knits and hard-wearing shoes.",
          ctaLabel: "Shop the wardrobe",
          href: "/c/wardrobe",
          imageMediaId: "",
        },
      ],
    },
  },
  {
    key: "homepage.rail.bestsellers",
    type: "product_rail",
    title: "Bestsellers",
    position: 4,
    data: {
      eyebrow: "Most loved",
      title: "Bestsellers",
      source: "bestsellers",
      categorySlug: "",
      productIds: [],
      actionLabel: "Shop bestsellers",
      actionHref: "/c/all?sort=bestselling",
      limit: 10,
    },
  },
  {
    key: "homepage.valueprops.default",
    type: "value_props",
    title: "Value props",
    position: 5,
    data: {
      items: [
        { icon: "truck", title: "Free shipping over ₱2,500", body: "Flat ₱150 below that. Express available." },
        { icon: "returns", title: "30-day returns", body: "Changed your mind? Send it back, no fuss." },
        { icon: "compass", title: "Discover more for everyday living", body: "Find useful products for every part of life." },
        { icon: "headset", title: "Helpful support", body: "We're here to help before, during, and after your purchase." },
      ],
    },
  },
  {
    key: "homepage.rail.sale",
    type: "product_rail",
    title: "On sale now",
    position: 6,
    data: {
      eyebrow: "Reduced",
      title: "On sale now",
      source: "on_sale",
      categorySlug: "",
      productIds: [],
      actionLabel: "All sale items",
      actionHref: "/c/sale",
      limit: 10,
    },
  },
];

type PageSeed = {
  slug: string;
  title: string;
  excerpt: string;
  seoTitle?: string;
  seoDescription?: string;
  body: string;
};

// The legal / core informational pages (About, Contact, FAQ, Shipping, Returns,
// Cancellation, Privacy, Terms) live in scripts/seed-legal-content.ts, which
// runs from seedCms() below. Only the two lighter pages are seeded here.
const PAGES: PageSeed[] = [
  {
    slug: "care",
    title: "Assembly & care",
    excerpt: "Keep your pieces looking their best.",
    body:
      "## Assembly\n\nFlat-packed furniture includes step-by-step instructions and all the hardware you need. If you'd rather not, assembly help is available at checkout in supported areas.\n\n## Care\n\n- **Wood:** dust with a soft dry cloth; avoid direct sun and heat sources.\n- **Textiles:** most covers are machine-washable — check the label on the product page.\n- **Metal & stone:** wipe with a damp cloth, dry immediately.\n\n_Selected products are represented using Axiaro's in-house product illustration system rather than photographs. Care guidance for your specific item is shown on its product page._",
  },
  {
    slug: "cookies",
    title: "Cookie policy",
    excerpt: "How this site uses cookies.",
    body:
      "## What cookies we use\n\n- **Essential:** sign-in, cart and checkout. These can't be turned off.\n- **Preferences:** remembering small choices like a filter or a tab.\n\nThis store does not use advertising or cross-site tracking cookies.",
  },
];

export async function seedCms(prisma: PrismaClient, log: (m: string) => void = () => {}) {
  let blocksCreated = 0;
  for (const b of HOMEPAGE_BLOCKS) {
    const existing = await prisma.contentBlock.findUnique({ where: { key: b.key } });
    if (existing) continue;
    await prisma.contentBlock.create({
      data: {
        key: b.key,
        area: "homepage",
        type: b.type,
        title: b.title,
        data: JSON.stringify(b.data),
        position: b.position,
        status: "PUBLISHED",
      },
    });
    blocksCreated++;
  }

  let pagesCreated = 0;
  for (const p of PAGES) {
    const existing = await prisma.contentPage.findUnique({ where: { slug: p.slug } });
    if (existing) continue;
    await prisma.contentPage.create({
      data: {
        slug: p.slug,
        title: p.title,
        status: "PUBLISHED",
        excerpt: p.excerpt,
        body: p.body,
        seoTitle: p.seoTitle ?? null,
        seoDescription: p.seoDescription ?? p.excerpt,
        publishedAt: new Date(),
      },
    });
    pagesCreated++;
  }

  log(`CMS: ${blocksCreated} homepage block(s) + ${pagesCreated} page(s) created`);

  // Legal / core informational pages (Step 19) — idempotent upsert.
  await seedLegalContent(prisma, log);
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const prisma = new PrismaClient({
    datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL,
  });
  seedCms(prisma, (m) => console.log(m))
    .then(() => console.log("CMS seed complete."))
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
