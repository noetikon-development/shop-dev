import Link from "next/link";
import Image from "next/image";
import { Truck, RotateCcw, ShieldCheck, Wrench, Check, Star, Sparkles, Compass, Headset } from "lucide-react";
import { ProductArt } from "@/lib/product-art";
import { ProductRail } from "@/components/product-rail";
import { CategoryTiles } from "@/components/home/category-tiles";
import { SectionHeading } from "@/components/ui/primitives";
import { Markdown } from "@/lib/markdown";
import {
  getBestSellers,
  getNewArrivals,
  getOnSale,
  getCategoryRail,
  getProductCardsByIds,
} from "@/lib/data";
import { resolveMediaUrls } from "@/lib/admin/media";
import type { PublicBlock } from "@/lib/content";
import type { CategoryNode } from "@/lib/types";

/** Renders the CMS-driven homepage. `page.tsx` passes published blocks + tree. */
export async function HomepageBlocks({
  blocks,
  tree,
}: {
  blocks: PublicBlock[];
  tree: CategoryNode[];
}) {
  // Resolve every media id referenced across all blocks in one query.
  const ids: string[] = [];
  for (const b of blocks) {
    if (b.type === "hero") {
      if (typeof b.data.imageMediaId === "string") ids.push(b.data.imageMediaId);
      if (Array.isArray(b.data.heroImages)) {
        for (const id of b.data.heroImages) if (typeof id === "string") ids.push(id);
      }
    }
    if (b.type === "feature_grid" && Array.isArray(b.data.items)) {
      for (const it of b.data.items as Record<string, unknown>[]) {
        if (typeof it.imageMediaId === "string") ids.push(it.imageMediaId);
      }
    }
  }
  const media = await resolveMediaUrls(ids.filter(Boolean));

  const rendered = await Promise.all(
    blocks.map(async (block) => {
      switch (block.type) {
        case "hero":
          return <HeroBlock key={block.id} data={block.data} media={media} />;
        case "category_tiles":
          return (
            <CategoryTiles
              key={block.id}
              categories={tree}
              eyebrow={str(block.data.eyebrow) || undefined}
              heading={str(block.data.heading) || undefined}
            />
          );
        case "product_rail":
          return <ProductRailBlock key={block.id} data={block.data} />;
        case "feature_grid":
          return <FeatureGridBlock key={block.id} data={block.data} media={media} />;
        case "value_props":
          return <ValuePropsBlock key={block.id} data={block.data} />;
        case "rich_text":
          return <RichTextBlock key={block.id} data={block.data} />;
        case "editorial":
          return <EditorialBlock key={block.id} data={block.data} />;
        default:
          return null;
      }
    }),
  );

  // Homepage vertical rhythm. One `gap` per boundary (no `space-y` + margin
  // stacking): major transitions 36 / 48 / 64, and the value-props strip forms
  // a tighter cluster with the rails that bracket it (24 / 32 / 40) so it reads
  // as a supporting band close to the products it supports.
  const vpIdx = blocks.findIndex((b) => b.type === "value_props");
  const clusterStart = vpIdx > 0 ? vpIdx - 1 : vpIdx;
  const clusterEnd = vpIdx >= 0 ? Math.min(vpIdx + 1, blocks.length - 1) : -1;

  return (
    <div className="home-root flex flex-col gap-9 md:gap-12 lg:gap-16">
      {vpIdx < 0
        ? rendered
        : [
            ...rendered.slice(0, clusterStart),
            <div key="vp-cluster" className="flex flex-col gap-6 md:gap-10">
              {rendered.slice(clusterStart, clusterEnd + 1)}
            </div>,
            ...rendered.slice(clusterEnd + 1),
          ]}
    </div>
  );
}

type MediaMap = Awaited<ReturnType<typeof resolveMediaUrls>>;

function mediaUrlOf(map: MediaMap, id: unknown): string | null {
  if (typeof id !== "string" || !id) return null;
  const asset = map.get(id);
  return asset && asset.mimeType.startsWith("image/") ? asset.url : null;
}

function mediaAltOf(map: MediaMap, id: unknown): string {
  if (typeof id !== "string" || !id) return "";
  return map.get(id)?.alt ?? "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function SafeCta({ label, href, variant }: { label: string; href: string; variant: "primary" | "outline" }) {
  if (!label || !href) return null;
  const cls = variant === "primary" ? "btn btn-primary" : "btn btn-outline";
  return href.startsWith("/") ? (
    <Link href={href} className={cls}>
      {label}
    </Link>
  ) : (
    <a href={href} rel="noopener" className={cls}>
      {label}
    </a>
  );
}

// --- hero -----------------------------------------------------------------

// The four hero panels, fixed order. Kinds match the built-in illustrations so
// an empty panel looks exactly as it did before this became editable.
const HERO_PANEL_KINDS = ["sofa", "lighting", "tableware", "apparel-top"] as const;

function HeroBlock({ data, media }: { data: Record<string, unknown>; media: MediaMap }) {
  const notes = Array.isArray(data.notes) ? (data.notes as unknown[]).map(str).filter(Boolean) : [];

  const panelIds = (Array.isArray(data.heroImages) ? (data.heroImages as unknown[]) : [])
    .map((v) => (typeof v === "string" ? v : ""))
    .slice(0, 4);
  while (panelIds.length < 4) panelIds.push("");

  // Backward compatibility: a store that set the old single hero image and has
  // no panel images yet keeps seeing that one image, unchanged.
  const legacyUrl = mediaUrlOf(media, data.imageMediaId);
  const useLegacySingle = panelIds.every((id) => !id) && Boolean(legacyUrl);

  return (
    <section className="container-page pt-6 sm:pt-10">
      <div className="grid overflow-hidden rounded-lg border border-line bg-surface lg:grid-cols-2">
        <div className="flex flex-col justify-center gap-5 p-8 sm:p-10 lg:px-14 lg:py-12">
          {str(data.eyebrow) && <p className="eyebrow">{str(data.eyebrow)}</p>}
          <h1 className="text-balance text-4xl sm:text-5xl lg:text-hero">
            {str(data.heading) || "Considered things for everyday living"}
          </h1>
          {str(data.body) && <p className="max-w-md text-pretty text-ink-soft">{str(data.body)}</p>}
          <div className="flex flex-wrap gap-3">
            <SafeCta label={str(data.ctaLabel)} href={str(data.ctaHref)} variant="primary" />
            <SafeCta label={str(data.secondaryCtaLabel)} href={str(data.secondaryCtaHref)} variant="outline" />
          </div>
          {notes.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-8 gap-y-2 text-meta text-ink-faint">
              {notes.map((n) => (
                <span key={n}>{n}</span>
              ))}
            </div>
          )}
        </div>

        <div className="relative h-[300px] bg-line max-lg:border-t max-lg:border-line lg:h-full">
          {useLegacySingle ? (
            <Image src={legacyUrl!} alt={str(data.heading) || "Featured"} fill className="object-cover" priority sizes="(max-width: 1024px) 100vw, 50vw" />
          ) : (
            <div className="grid h-full grid-cols-2 grid-rows-2 gap-px">
              {HERO_PANEL_KINDS.map((kind, i) => {
                const url = mediaUrlOf(media, panelIds[i]);
                return (
                  <div key={kind} className="relative">
                    {url ? (
                      <Image
                        src={url}
                        alt={mediaAltOf(media, panelIds[i])}
                        fill
                        className="object-cover"
                        priority={i === 0}
                        sizes="(max-width: 1024px) 50vw, 25vw"
                      />
                    ) : (
                      <ProductArt kind={kind} seed={`hero-${i}`} />
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// --- product rail --------------------------------------------------------

async function ProductRailBlock({ data }: { data: Record<string, unknown> }) {
  const limit = typeof data.limit === "number" ? data.limit : 10;
  const source = str(data.source);
  let products;
  if (source === "new_arrivals") products = await getNewArrivals(limit);
  else if (source === "on_sale") products = await getOnSale(limit);
  else if (source === "category") products = await getCategoryRail(str(data.categorySlug), limit);
  else if (source === "manual")
    products = await getProductCardsByIds(
      Array.isArray(data.productIds) ? (data.productIds as unknown[]).map(str).filter(Boolean) : [],
    );
  else products = await getBestSellers(limit);

  if (!products.length) return null;
  const actionLabel = str(data.actionLabel);
  const actionHref = str(data.actionHref);

  // Each homepage rail reads differently by its source: bestsellers laid out
  // as a static grid ("here's the set"), the sale rail understated at the foot
  // of the page, new arrivals as the open discovery scroller.
  const style =
    source === "bestsellers"
      ? ({ variant: "grid" } as const)
      : source === "on_sale"
        ? ({ compact: true } as const)
        : ({} as const);

  return (
    <ProductRail
      eyebrow={str(data.eyebrow) || undefined}
      title={str(data.title) || "Products"}
      action={actionLabel && actionHref ? { label: actionLabel, href: actionHref } : undefined}
      products={products}
      showCategory
      fluidHeight
      mobileGrid
      {...style}
    />
  );
}

// --- feature grid -------------------------------------------------------

function FeatureGridBlock({
  data,
  media,
}: {
  data: Record<string, unknown>;
  media: Awaited<ReturnType<typeof resolveMediaUrls>>;
}) {
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  if (!items.length) return null;
  return (
    <section className="container-page grid gap-4 md:grid-cols-2">
      {items.map((f, i) => {
        const href = str(f.href) || "/c/all";
        const url = mediaUrlOf(media, f.imageMediaId);
        const inner = (
          <>
            <div className="flex flex-col justify-center gap-3 p-6 sm:p-8">
              {str(f.eyebrow) && <p className="eyebrow">{str(f.eyebrow)}</p>}
              <h3 className="text-subtitle sm:text-title">{str(f.title)}</h3>
              {str(f.body) && <p className="text-body text-ink-soft">{str(f.body)}</p>}
              {str(f.ctaLabel) && (
                <span className="link-underline mt-1 w-fit text-meta font-medium">{str(f.ctaLabel)} →</span>
              )}
            </div>
            <div className="relative min-h-44 bg-surface-sunken">
              {url ? (
                <Image
                  src={url}
                  alt={mediaAltOf(media, f.imageMediaId) || str(f.title)}
                  fill
                  className="object-cover transition-transform duration-500 group-hover:scale-105"
                  sizes="(max-width: 768px) 100vw, 50vw"
                />
              ) : (
                <ProductArt kind="decor" seed={`feature-${i}`} className="transition-transform duration-500 group-hover:scale-105" />
              )}
            </div>
          </>
        );
        return href.startsWith("/") ? (
          <Link key={i} href={href} className="group grid overflow-hidden rounded-lg border border-line sm:grid-cols-[1.1fr_1fr]">
            {inner}
          </Link>
        ) : (
          <a key={i} href={href} rel="noopener" className="group grid overflow-hidden rounded-lg border border-line sm:grid-cols-[1.1fr_1fr]">
            {inner}
          </a>
        );
      })}
    </section>
  );
}

// --- value props ------------------------------------------------------

const VALUE_ICONS: Record<string, typeof Truck> = {
  truck: Truck,
  returns: RotateCcw,
  shield: ShieldCheck,
  wrench: Wrench,
  star: Star,
  sparkles: Sparkles,
  check: Check,
  compass: Compass,
  headset: Headset,
};

function ValuePropsBlock({ data }: { data: Record<string, unknown> }) {
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : [];
  if (!items.length) return null;
  return (
    <section>
      <div className="container-page grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
        {items.map((p, i) => {
          const Icon = VALUE_ICONS[str(p.icon)] ?? Check;
          return (
            <div key={i} className="flex gap-3.5">
              <Icon size={22} strokeWidth={1.5} className="mt-0.5 shrink-0 text-clay" />
              <div>
                <p className="text-body font-medium">{str(p.title)}</p>
                {str(p.body) && <p className="mt-1 text-meta text-ink-faint">{str(p.body)}</p>}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- rich text -------------------------------------------------------

function RichTextBlock({ data }: { data: Record<string, unknown> }) {
  const body = str(data.body);
  if (!body && !str(data.heading)) return null;
  return (
    <section className="container-page">
      {str(data.heading) && <SectionHeading title={str(data.heading)} />}
      <div className="mt-4 max-w-2xl text-body">
        <Markdown source={body} />
      </div>
    </section>
  );
}

// --- editorial statement --------------------------------------------------

/**
 * A quiet full-width pause between product sections (Phase 5D Stage 5). One
 * line of display type, generous whitespace — no image, no card, no CTA.
 */
function EditorialBlock({ data }: { data: Record<string, unknown> }) {
  const eyebrow = str(data.eyebrow);
  const heading = str(data.heading);
  const body = str(data.body);
  if (!heading && !body) return null;
  return (
    <section className="border-y border-line" aria-label="Editorial">
      <div className="container-page py-16 text-center sm:py-24">
        {eyebrow && <p className="eyebrow mb-4">{eyebrow}</p>}
        {heading && (
          <h2 className="mx-auto max-w-3xl text-balance text-title text-ink sm:text-display">
            {heading}
          </h2>
        )}
        {body && (
          <p className="mx-auto mt-4 max-w-xl text-pretty text-body text-ink-soft">{body}</p>
        )}
      </div>
    </section>
  );
}
