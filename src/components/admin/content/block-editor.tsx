"use client";

import { startTransition, useRef, useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { Card, FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import { MediaPickerField } from "@/components/admin/media/media-picker";
import { FEATURE_CARD_IMAGE_SPEC } from "@/lib/media-constants";
import {
  createBlockAction,
  updateBlockAction,
  type BlockActionState,
} from "@/lib/admin/content-block-actions";
import {
  BLOCK_TYPES,
  BLOCK_TYPE_KEYS,
  PRODUCT_RAIL_SOURCES,
  HERO_PANEL_LABELS,
  type BlockTypeKey,
} from "@/lib/content-blocks";
import type { PickerAsset } from "@/lib/admin/media-picker-data";

const EMPTY: BlockActionState = {};

type ProductOption = { id: string; name: string; slug: string; status: string };
type CategoryOption = { slug: string; name: string };

type BlockDefaults = {
  id: string;
  type: BlockTypeKey;
  title: string | null;
  status: "DRAFT" | "PUBLISHED";
  data: Record<string, unknown>;
};

export function BlockEditor({
  block,
  defaultType,
  mediaAssets,
  products,
  categories,
  onDone,
}: {
  block?: BlockDefaults;
  defaultType?: BlockTypeKey;
  mediaAssets: PickerAsset[];
  products: ProductOption[];
  categories: CategoryOption[];
  onDone: () => void;
}) {
  const router = useRouter();
  const editing = Boolean(block);
  const [type, setType] = useState<BlockTypeKey>(block?.type ?? defaultType ?? "hero");
  const d = block?.data ?? {};

  const { state, dispatch, pending } = usePersistentAction<BlockActionState>(
    editing ? updateBlockAction : createBlockAction,
    EMPTY,
  );
  const doneRef = useRef(false);

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    notify.success(editing ? "Section saved" : "Section added");
    onDone();
    router.refresh();
  }, [state.ok, editing, onDone, router]);
  useEffect(() => {
    if (state.error) doneRef.current = false;
  }, [state]);

  // Repeatable items (feature_grid / value_props).
  const initialItems = Array.isArray(d.items) ? (d.items as Record<string, unknown>[]) : [];
  const [items, setItems] = useState<Record<string, unknown>[]>(
    initialItems.length ? initialItems : type === "feature_grid" ? [{}] : type === "value_props" ? [{}] : [],
  );
  // Manual product ids for product_rail.
  const [productIds, setProductIds] = useState<string[]>(
    Array.isArray(d.productIds) ? (d.productIds as string[]) : [],
  );
  const [railSource, setRailSource] = useState<string>(typeof d.source === "string" ? d.source : "bestsellers");
  const heroImage = typeof d.imageMediaId === "string" ? d.imageMediaId : "";
  const heroImagesData = Array.isArray(d.heroImages) ? (d.heroImages as unknown[]).map(String) : [];
  const featureImages = initialItems.map((it) =>
    typeof it.imageMediaId === "string" ? (it.imageMediaId as string) : "",
  );

  const formRef = useRef<HTMLFormElement>(null);

  function buildPayload(fd: FormData): Record<string, unknown> {
    const g = (id: string) => String(fd.get(id) ?? "");
    switch (type) {
      case "hero":
        return {
          eyebrow: g("hero-eyebrow"),
          heading: g("hero-heading"),
          body: g("hero-body"),
          ctaLabel: g("hero-ctaLabel"),
          ctaHref: g("hero-ctaHref"),
          secondaryCtaLabel: g("hero-secondaryCtaLabel"),
          secondaryCtaHref: g("hero-secondaryCtaHref"),
          // Legacy single image — preserved untouched, no longer edited here.
          imageMediaId: heroImage,
          // The four fixed panels, in order. "" = keep the built-in illustration.
          heroImages: [0, 1, 2, 3].map((i) => g(`__heroImage-${i}`)),
          notes: g("hero-notes").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 6),
        };
      case "product_rail":
        return {
          eyebrow: g("rail-eyebrow"),
          title: g("rail-title"),
          source: railSource,
          categorySlug: g("rail-categorySlug"),
          productIds,
          actionLabel: g("rail-actionLabel"),
          actionHref: g("rail-actionHref"),
          limit: Number(g("rail-limit") || "10") || 10,
        };
      case "feature_grid":
        return {
          items: items.map((_, i) => ({
            eyebrow: g(`feat-${i}-eyebrow`),
            title: g(`feat-${i}-title`),
            body: g(`feat-${i}-body`),
            ctaLabel: g(`feat-${i}-ctaLabel`),
            href: g(`feat-${i}-href`),
            imageMediaId: g(`__feat-${i}-image`) || featureImages[i] || "",
          })),
        };
      case "value_props":
        return {
          items: items.map((_, i) => ({
            icon: g(`vp-${i}-icon`) || "check",
            title: g(`vp-${i}-title`),
            body: g(`vp-${i}-body`),
          })),
        };
      case "rich_text":
        return { heading: g("rt-heading"), body: g("rt-body") };
      case "category_tiles":
        return { eyebrow: g("ct-eyebrow"), heading: g("ct-heading") };
      default:
        return {};
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const data = buildPayload(fd);
    const out = new FormData();
    if (editing) out.set("id", block!.id);
    out.set("type", type);
    out.set("area", "homepage");
    out.set("title", String(fd.get("title") ?? ""));
    out.set("status", String(fd.get("status") ?? "DRAFT"));
    out.set("data", JSON.stringify(data));
    startTransition(() => dispatch(out));
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-5">
      <Card>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Section type" htmlFor="b-type">
            <Select
              id="b-type"
              value={type}
              onChange={(e) => setType(e.target.value as BlockTypeKey)}
              disabled={editing}
            >
              {BLOCK_TYPE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {BLOCK_TYPES[k].label}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Internal name" htmlFor="b-title" hint="Only shown in this admin list.">
            <input id="b-title" name="title" className="field" defaultValue={block?.title ?? ""} />
          </FormField>
        </div>
        <p className="mt-2 text-xs text-ink-faint">{BLOCK_TYPES[type].description}</p>
      </Card>

      {type === "hero" && (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id="hero-eyebrow" label="Eyebrow" d={d.eyebrow} />
            <Text id="hero-heading" label="Heading" d={d.heading} />
          </div>
          <Area id="hero-body" label="Body" d={d.body} />
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id="hero-ctaLabel" label="Primary button label" d={d.ctaLabel} />
            <Text id="hero-ctaHref" label="Primary button link" d={d.ctaHref} placeholder="/c/all" />
            <Text id="hero-secondaryCtaLabel" label="Secondary button label" d={d.secondaryCtaLabel} />
            <Text id="hero-secondaryCtaHref" label="Secondary button link" d={d.secondaryCtaHref} placeholder="/c/new" />
          </div>
          <Area id="hero-notes" label="Reassurance notes (one per line)" d={(d.notes as string[] | undefined)?.join("\n")} />
          <div className="space-y-3 rounded-md border border-line p-3">
            <div>
              <p className="text-sm font-medium text-ink">Hero panels</p>
              <p className="text-xs text-ink-faint">
                The four visuals in the hero, in fixed order. Upload, replace or clear each one
                independently. An empty panel keeps its built-in illustration until you add an image.
              </p>
            </div>
            {HERO_PANEL_LABELS.map((panelLabel, i) => (
              <MediaPickerField
                key={i}
                name={`__heroImage-${i}`}
                label={panelLabel}
                assets={mediaAssets}
                defaultValue={heroImagesData[i] ?? ""}
                uploadFolder="hero"
                showSpecHints
              />
            ))}
          </div>
        </Card>
      )}

      {type === "product_rail" && (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id="rail-eyebrow" label="Eyebrow" d={d.eyebrow} />
            <Text id="rail-title" label="Title" d={d.title} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Products from" htmlFor="rail-source">
              <Select id="rail-source" value={railSource} onChange={(e) => setRailSource(e.target.value)}>
                {PRODUCT_RAIL_SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace("_", " ")}
                  </option>
                ))}
              </Select>
            </FormField>
            <Text id="rail-limit" label="Max products" d={d.limit ?? 10} type="number" />
          </div>
          {railSource === "category" && (
            <FormField label="Category" htmlFor="rail-categorySlug">
              <Select id="rail-categorySlug" name="rail-categorySlug" defaultValue={String(d.categorySlug ?? "")}>
                <option value="">Choose a category…</option>
                {categories.map((c) => (
                  <option key={c.slug} value={c.slug}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </FormField>
          )}
          {railSource === "manual" && (
            <ProductPicker products={products} selected={productIds} onChange={setProductIds} />
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id="rail-actionLabel" label="Link label (optional)" d={d.actionLabel} />
            <Text id="rail-actionHref" label="Link target" d={d.actionHref} placeholder="/c/all" />
          </div>
        </Card>
      )}

      {type === "feature_grid" && (
        <Card className="space-y-4">
          {items.map((_, i) => (
            <div key={i} className="rounded-md border border-line p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-soft">Card {i + 1}</span>
                {items.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setItems((c) => c.filter((_, j) => j !== i))}
                    className="text-xs text-clay"
                  >
                    <Trash2 size={12} className="inline" /> Remove
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Text id={`feat-${i}-eyebrow`} label="Eyebrow" d={(items[i] as Record<string, unknown>).eyebrow} />
                <Text id={`feat-${i}-title`} label="Title" d={(items[i] as Record<string, unknown>).title} />
              </div>
              <Area id={`feat-${i}-body`} label="Body" d={(items[i] as Record<string, unknown>).body} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Text id={`feat-${i}-ctaLabel`} label="Link label" d={(items[i] as Record<string, unknown>).ctaLabel} />
                <Text id={`feat-${i}-href`} label="Link target" d={(items[i] as Record<string, unknown>).href} placeholder="/c/wardrobe" />
              </div>
              <MediaPickerField
                name={`__feat-${i}-image`}
                label="Card image"
                hint="A real lifestyle photo. Leave empty to keep the built-in illustration. Set the image's alt text in Media."
                assets={mediaAssets}
                defaultValue={featureImages[i] ?? ""}
                uploadFolder="homepage"
                showSpecHints
                spec={FEATURE_CARD_IMAGE_SPEC}
              />
            </div>
          ))}
          {items.length < 4 && (
            <button
              type="button"
              onClick={() => setItems((c) => [...c, {}])}
              className="btn btn-outline py-1.5 text-xs"
            >
              <Plus size={12} /> Add card
            </button>
          )}
        </Card>
      )}

      {type === "value_props" && (
        <Card className="space-y-4">
          {items.map((_, i) => (
            <div key={i} className="rounded-md border border-line p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-ink-soft">Item {i + 1}</span>
                {items.length > 1 && (
                  <button type="button" onClick={() => setItems((c) => c.filter((_, j) => j !== i))} className="text-xs text-clay">
                    Remove
                  </button>
                )}
              </div>
              <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
                <FormField label="Icon" htmlFor={`vp-${i}-icon`}>
                  <Select id={`vp-${i}-icon`} name={`vp-${i}-icon`} defaultValue={String((items[i] as Record<string, unknown>).icon ?? "check")}>
                    {["check", "truck", "returns", "shield", "wrench", "star", "sparkles"].map((ic) => (
                      <option key={ic} value={ic}>
                        {ic}
                      </option>
                    ))}
                  </Select>
                </FormField>
                <Text id={`vp-${i}-title`} label="Title" d={(items[i] as Record<string, unknown>).title} />
              </div>
              <Text id={`vp-${i}-body`} label="Detail" d={(items[i] as Record<string, unknown>).body} />
            </div>
          ))}
          {items.length < 6 && (
            <button type="button" onClick={() => setItems((c) => [...c, {}])} className="btn btn-outline py-1.5 text-xs">
              <Plus size={12} /> Add item
            </button>
          )}
        </Card>
      )}

      {type === "rich_text" && (
        <Card className="space-y-4">
          <Text id="rt-heading" label="Heading (optional)" d={d.heading} />
          <Area id="rt-body" label="Body (Markdown)" d={d.body} rows={8} />
        </Card>
      )}

      {type === "category_tiles" && (
        <Card className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Text id="ct-eyebrow" label="Eyebrow (optional)" d={d.eyebrow} />
            <Text id="ct-heading" label="Heading (optional)" d={d.heading} />
          </div>
          <p className="text-xs text-ink-faint">
            The tiles themselves come from your categories. Set each category&apos;s image in
            Products → Categories.
          </p>
        </Card>
      )}

      <Card>
        <FormField label="Status" htmlFor="b-status" hint="Only published sections appear on the homepage.">
          <Select id="b-status" name="status" defaultValue={block?.status ?? "DRAFT"}>
            <option value="DRAFT">Draft</option>
            <option value="PUBLISHED">Published</option>
          </Select>
        </FormField>
      </Card>

      {state.error && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onDone} className="btn btn-outline py-2 text-sm">
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          {editing ? "Save section" : "Add section"}
        </button>
      </div>
    </form>
  );
}

// --- helpers ------------------------------------------------------------

function Text({
  id,
  label,
  d,
  placeholder,
  type = "text",
}: {
  id: string;
  label: string;
  d?: unknown;
  placeholder?: string;
  type?: string;
}) {
  return (
    <FormField label={label} htmlFor={id}>
      <input id={id} name={id} type={type} className="field text-sm" placeholder={placeholder} defaultValue={d == null ? "" : String(d)} />
    </FormField>
  );
}

function Area({ id, label, d, rows = 3 }: { id: string; label: string; d?: unknown; rows?: number }) {
  return (
    <FormField label={label} htmlFor={id}>
      <textarea id={id} name={id} rows={rows} className="field text-sm" defaultValue={d == null ? "" : String(d)} />
    </FormField>
  );
}

function ProductPicker({
  products,
  selected,
  onChange,
}: {
  products: ProductOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const [q, setQ] = useState("");
  const filtered = products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const chosen = selected.map((id) => products.find((p) => p.id === id)).filter(Boolean) as ProductOption[];

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium text-ink">Products (in order)</p>
      {chosen.length > 0 && (
        <ol className="space-y-1">
          {chosen.map((p, i) => (
            <li key={p.id} className="flex items-center justify-between rounded border border-line px-2 py-1 text-sm">
              <span>
                {i + 1}. {p.name}
                {p.status !== "ACTIVE" && <span className="ml-2 text-xs text-clay">({p.status})</span>}
              </span>
              <button type="button" onClick={() => onChange(selected.filter((x) => x !== p.id))} className="text-xs text-clay">
                Remove
              </button>
            </li>
          ))}
        </ol>
      )}
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products…" className="field text-sm" />
      <ul className="max-h-40 space-y-1 overflow-y-auto rounded border border-line p-1">
        {filtered.slice(0, 30).map((p) => (
          <li key={p.id}>
            <button
              type="button"
              disabled={selected.includes(p.id) || selected.length >= 16}
              onClick={() => onChange([...selected, p.id])}
              className="w-full rounded px-2 py-1 text-left text-sm hover:bg-surface-sunken disabled:opacity-40"
            >
              {p.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
