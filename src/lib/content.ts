import "server-only";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  parseBlockData,
  footerSchema,
  navSchema,
  type BlockTypeKey,
  type FooterData,
  type NavData,
} from "@/lib/content-blocks";

/**
 * Storefront-facing CMS reads (Step 16). Cached with the `content` tag so an
 * admin publish (which calls `revalidateTag("content")`) refreshes the affected
 * pages without a redeploy.
 *
 * Only PUBLISHED content is ever returned here.
 */

export type PublicPage = {
  slug: string;
  title: string;
  excerpt: string | null;
  body: string;
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

const loadPage = unstable_cache(
  async (slug: string): Promise<PublicPage | null> => {
    const page = await prisma.contentPage.findFirst({
      where: { slug, status: "PUBLISHED" },
      select: {
        slug: true,
        title: true,
        excerpt: true,
        body: true,
        seoTitle: true,
        seoDescription: true,
        publishedAt: true,
        updatedAt: true,
      },
    });
    if (!page) return null;
    return {
      ...page,
      publishedAt: page.publishedAt?.toISOString() ?? null,
      updatedAt: page.updatedAt.toISOString(),
    };
  },
  ["content-page"],
  { revalidate: 300, tags: ["content"] },
);

export function getPublishedPage(slug: string): Promise<PublicPage | null> {
  return loadPage(slug);
}

export const getPublishedPageSlugs = unstable_cache(
  async (): Promise<string[]> => {
    const rows = await prisma.contentPage.findMany({
      where: { status: "PUBLISHED" },
      select: { slug: true },
    });
    return rows.map((r) => r.slug);
  },
  ["content-page-slugs"],
  { revalidate: 300, tags: ["content"] },
);

export type PublicBlock = {
  id: string;
  key: string;
  type: BlockTypeKey;
  title: string | null;
  position: number;
  data: Record<string, unknown>;
};

const loadHomepageBlocks = unstable_cache(
  async (): Promise<PublicBlock[]> => {
    const rows = await prisma.contentBlock.findMany({
      where: { area: "homepage", status: "PUBLISHED" },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    });
    return rows
      .filter((r): r is typeof r & { type: BlockTypeKey } =>
        ["hero", "feature_grid", "product_rail", "value_props", "rich_text", "category_tiles"].includes(r.type),
      )
      .map((r) => ({
        id: r.id,
        key: r.key,
        type: r.type,
        title: r.title,
        position: r.position,
        data: parseBlockData(r.type, r.data),
      }));
  },
  ["content-homepage-blocks"],
  { revalidate: 120, tags: ["content"] },
);

export function getHomepageBlocks(): Promise<PublicBlock[]> {
  return loadHomepageBlocks();
}

/**
 * The site-wide footer content (Phase 5A). One PUBLISHED `area:"global"` block
 * keyed `footer.default`. Returns `null` when the block is absent or not
 * published — the footer component then falls back to its built-in structure,
 * so the storefront footer never disappears.
 */
const loadFooterBlock = unstable_cache(
  async (): Promise<FooterData | null> => {
    const row = await prisma.contentBlock.findFirst({
      where: { area: "global", type: "footer", status: "PUBLISHED" },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { data: true },
    });
    if (!row) return null;
    const parsed = footerSchema.safeParse(safeJson(row.data));
    return parsed.success ? parsed.data : null;
  },
  ["content-footer-block"],
  { revalidate: 300, tags: ["content"] },
);

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function getFooterBlock(): Promise<FooterData | null> {
  return loadFooterBlock();
}

/**
 * The primary-navigation content (Phase 5C). One PUBLISHED `area:"global"`
 * block keyed `nav.primary`. Returns `null` when the block is absent, not
 * published or malformed — `getResolvedNav()` then falls back to the built-in
 * navigation, so the header never loses its menu.
 */
const loadNavBlock = unstable_cache(
  async (): Promise<NavData | null> => {
    const row = await prisma.contentBlock.findFirst({
      where: { area: "global", type: "navigation", status: "PUBLISHED" },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { data: true },
    });
    if (!row) return null;
    const parsed = navSchema.safeParse(safeJson(row.data));
    return parsed.success ? parsed.data : null;
  },
  ["content-nav-block"],
  { revalidate: 300, tags: ["content"] },
);

export function getNavBlock(): Promise<NavData | null> {
  return loadNavBlock();
}
