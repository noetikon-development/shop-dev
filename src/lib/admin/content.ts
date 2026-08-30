import "server-only";
import { prisma } from "@/lib/prisma";
import { BLOCK_TYPES, parseBlockData, type BlockTypeKey } from "@/lib/content-blocks";

/**
 * Admin read layer for the CMS (Step 16). Uncached — editors see live data.
 */

// ---------------------------------------------------------------------------
// Content pages
// ---------------------------------------------------------------------------

export type AdminPageRow = {
  id: string;
  slug: string;
  title: string;
  status: string;
  updatedAt: string;
  publishedAt: string | null;
};

export async function listAdminPages(): Promise<AdminPageRow[]> {
  const rows = await prisma.contentPage.findMany({
    orderBy: [{ status: "asc" }, { title: "asc" }],
    select: { id: true, slug: true, title: true, status: true, updatedAt: true, publishedAt: true },
  });
  return rows.map((p) => ({
    id: p.id,
    slug: p.slug,
    title: p.title,
    status: p.status,
    updatedAt: p.updatedAt.toISOString(),
    publishedAt: p.publishedAt?.toISOString() ?? null,
  }));
}

export type AdminPageDetail = Awaited<ReturnType<typeof getAdminPage>>;

export async function getAdminPage(id: string) {
  const p = await prisma.contentPage.findUnique({ where: { id } });
  if (!p) return null;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    status: p.status as "DRAFT" | "PUBLISHED",
    excerpt: p.excerpt,
    body: p.body,
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Content blocks
// ---------------------------------------------------------------------------

export type AdminBlockRow = {
  id: string;
  key: string;
  area: string;
  type: string;
  typeLabel: string;
  title: string | null;
  position: number;
  status: string;
  updatedAt: string;
  summary: string;
};

function blockSummary(type: string, data: Record<string, unknown>): string {
  switch (type) {
    case "hero":
      return String(data.heading ?? "") || "—";
    case "product_rail":
      return `${data.title ?? ""} · ${data.source ?? ""}`.trim();
    case "feature_grid":
      return `${(data.items as unknown[] | undefined)?.length ?? 0} card(s)`;
    case "value_props":
      return `${(data.items as unknown[] | undefined)?.length ?? 0} item(s)`;
    case "rich_text":
      return String(data.heading ?? "") || "Text block";
    case "category_tiles":
      return "Category grid";
    default:
      return "—";
  }
}

export async function listAdminBlocks(area = "homepage"): Promise<AdminBlockRow[]> {
  const rows = await prisma.contentBlock.findMany({
    where: { area },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((b) => {
    const data = parseBlockData(b.type, b.data);
    return {
      id: b.id,
      key: b.key,
      area: b.area,
      type: b.type,
      typeLabel: BLOCK_TYPES[b.type as BlockTypeKey]?.label ?? b.type,
      title: b.title,
      position: b.position,
      status: b.status,
      updatedAt: b.updatedAt.toISOString(),
      summary: blockSummary(b.type, data),
    };
  });
}

export type AdminBlockDetail = Awaited<ReturnType<typeof getAdminBlock>>;

export async function getAdminBlock(id: string) {
  const b = await prisma.contentBlock.findUnique({ where: { id } });
  if (!b) return null;
  return {
    id: b.id,
    key: b.key,
    area: b.area,
    type: b.type as BlockTypeKey,
    title: b.title,
    position: b.position,
    status: b.status as "DRAFT" | "PUBLISHED",
    data: parseBlockData(b.type, b.data),
    rawData: b.data,
    createdAt: b.createdAt.toISOString(),
    updatedAt: b.updatedAt.toISOString(),
  };
}

/** Product options for the "manual" product-rail picker. */
export async function productPickerOptions(q?: string) {
  const rows = await prisma.product.findMany({
    where: q?.trim()
      ? { OR: [{ name: { contains: q.trim(), mode: "insensitive" } }, { slug: { contains: q.trim(), mode: "insensitive" } }] }
      : {},
    orderBy: { name: "asc" },
    take: 50,
    select: { id: true, name: true, slug: true, status: true },
  });
  return rows;
}
