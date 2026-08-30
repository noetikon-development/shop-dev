/**
 * Seeds the Step 16 CMS content:
 *   - homepage ContentBlocks that reproduce the built-in homepage (so the demo
 *     looks identical but is now editable in /admin/content/homepage);
 *   - demo ContentPages (About, Contact, FAQ, policies) — clearly marked as demo
 *     content, NOT legal advice.
 *
 * NON-DESTRUCTIVE: rows are created only if missing (matched by key / slug).
 * Existing rows — including admin edits — are left untouched. Run:
 *   npm run db:seed:cms
 */
import { pathToFileURL } from "node:url";
import { PrismaClient } from "@prisma/client";

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
      eyebrow: "Autumn / Winter — new in",
      heading: "Considered things for everyday living",
      body: "Furniture, lighting, textiles and a small wardrobe — designed in-house, made to last, and priced without the markup. Free shipping over ₱2,500.",
      ctaLabel: "Shop everything",
      ctaHref: "/c/all",
      secondaryCtaLabel: "See what's new",
      secondaryCtaHref: "/c/new",
      imageMediaId: "",
      notes: ["10-year furniture guarantee", "30-day returns", "Assembly help included"],
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
        { icon: "truck", title: "Free shipping over ₱2,500", body: "Flat ₱129 below that. Express available." },
        { icon: "returns", title: "30-day returns", body: "Changed your mind? Send it back, no fuss." },
        { icon: "shield", title: "10-year guarantee", body: "On the frame of every piece of furniture." },
        { icon: "wrench", title: "Assembly help", body: "Clear instructions, and a hand if you want one." },
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

const DEMO_NOTE =
  "> **Demo content.** This page is placeholder copy for the AXIARO demo store. It is not legal advice — replace it with text reviewed for your business before going live.\n\n";

type PageSeed = {
  slug: string;
  title: string;
  excerpt: string;
  seoTitle?: string;
  seoDescription?: string;
  body: string;
};

const PAGES: PageSeed[] = [
  {
    slug: "about",
    title: "About AXIARO",
    excerpt: "Why we make what we make, and how.",
    body:
      "## Our approach\n\nAXIARO designs homeware and a small wardrobe in-house, works directly with a short list of makers, and skips the traditional retail markup. The result is furniture and everyday pieces that are meant to last.\n\n## What we care about\n\n- **Materials you can trace** — solid wood, natural fibres, honest hardware.\n- **Repairable design** — covers that unzip, parts you can replace.\n- **Fair pricing** — no inflated \"RRP\" to discount from.\n\n_This is demo content for the AXIARO showcase store._",
  },
  {
    slug: "contact",
    title: "Contact us",
    excerpt: "We usually reply within one business day.",
    body:
      "## Get in touch\n\nFor order questions, use **[Track your order](/track)** first — it has the latest status.\n\nStill need a hand? Email us and include your order number if you have one.\n\n- **Email:** set this in Settings → Contact\n- **Hours:** set this in Settings → Contact\n\n_This is demo content for the AXIARO showcase store._",
  },
  {
    slug: "faq",
    title: "Frequently asked questions",
    excerpt: "Shipping, returns, assembly and care.",
    body:
      "## Orders & shipping\n\n**When will my order arrive?**\nStandard delivery is 3–7 business days; express is 1–3. You'll get tracking once it ships.\n\n**Do you ship outside the Philippines?**\nNot yet — delivery is Philippines-only for now.\n\n## Returns\n\n**What's your return window?**\n30 days from delivery for unused items in original packaging.\n\n## Assembly & care\n\n**Do items come assembled?**\nLarger furniture ships flat-packed with clear instructions. Care guidance is on each product page.\n\n_This is demo content for the AXIARO showcase store._",
  },
  {
    slug: "shipping",
    title: "Shipping & delivery",
    excerpt: "Rates, timings and what to expect.",
    body:
      "## Rates\n\n- **Standard delivery:** ₱129, 3–7 business days\n- **Express delivery:** ₱249, 1–3 business days\n- **Free standard shipping** on orders over ₱2,500\n- **Store pickup:** free, ready in 1–2 business days\n\n## Tracking\n\nEvery order gets a tracking link by email once it ships. You can also check status any time on the **[Track your order](/track)** page.\n\n_This is demo content for the AXIARO showcase store._",
  },
  {
    slug: "returns",
    title: "Returns & refunds",
    excerpt: "How to return an item and when you'll be refunded.",
    body:
      DEMO_NOTE +
      "## Return window\n\nYou can return most items within **30 days of delivery**, unused and in their original packaging.\n\n## How to return\n\n1. Contact us with your order number.\n2. We'll arrange collection for large items, or send a return label for small ones.\n3. Once the item is inspected, your refund is issued to the original payment method within 5–10 business days.\n\n## Non-returnable items\n\nMade-to-order and clearance items are final sale unless faulty.",
  },
  {
    slug: "care",
    title: "Assembly & care",
    excerpt: "Keep your pieces looking their best.",
    body:
      "## Assembly\n\nFlat-packed furniture includes step-by-step instructions and all the hardware you need. If you'd rather not, assembly help is available at checkout in supported areas.\n\n## Care\n\n- **Wood:** dust with a soft dry cloth; avoid direct sun and heat sources.\n- **Textiles:** most covers are machine-washable — check the label on the product page.\n- **Metal & stone:** wipe with a damp cloth, dry immediately.\n\n_This is demo content for the AXIARO showcase store._",
  },
  {
    slug: "privacy",
    title: "Privacy policy",
    excerpt: "What we collect and how we use it.",
    body:
      DEMO_NOTE +
      "## Information we collect\n\nWe collect the information you give us at checkout and when you create an account — your name, contact details, delivery address and order history.\n\n## How we use it\n\n- To process and deliver your orders.\n- To provide customer support.\n- To send order updates.\n\n## Your choices\n\nYou can access or delete your account data by contacting us. We do not sell personal information.",
  },
  {
    slug: "terms",
    title: "Terms & conditions",
    excerpt: "The rules for using this store.",
    body:
      DEMO_NOTE +
      "## Using this store\n\nBy placing an order you confirm the information you provide is accurate and that you're authorised to use the payment method.\n\n## Pricing & availability\n\nPrices are shown in Philippine peso and include applicable taxes. We may correct pricing errors and cancel affected orders with a full refund.\n\n## Orders\n\nAn order is a request to buy; our acceptance happens when we confirm dispatch.",
  },
  {
    slug: "cookies",
    title: "Cookie policy",
    excerpt: "How this site uses cookies.",
    body:
      DEMO_NOTE +
      "## What cookies we use\n\n- **Essential:** sign-in, cart and checkout. These can't be turned off.\n- **Preferences:** remembering small choices like a filter or a tab.\n\nThis demo store does not use advertising or cross-site tracking cookies.",
  },
  {
    slug: "cancellation",
    title: "Cancellation policy",
    excerpt: "Cancelling an order before it ships.",
    body:
      DEMO_NOTE +
      "## Before dispatch\n\nYou can cancel an order for a full refund any time before it is marked as shipped — contact us with your order number.\n\n## After dispatch\n\nOnce an order has shipped it follows the **Returns & refunds** process instead.",
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
