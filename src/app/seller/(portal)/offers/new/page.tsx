import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Search } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { findListableVariants } from "@/lib/seller/offers";
import { prisma } from "@/lib/prisma";
import { PageHeader, Card, EmptyState } from "@/components/seller/ui";
import { OfferCreateForm } from "@/components/seller/offer-create-form";
import { pesos } from "@/lib/seller/format";

export const metadata: Metadata = { title: "New offer" };

export default async function NewSellerOfferPage({
  searchParams,
}: PageProps<"/seller/offers/new">) {
  const { ctx } = await requireSellerSessionPermission("manage_offers");
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q : undefined;
  const variantId = typeof sp.variantId === "string" ? sp.variantId : undefined;

  // Step 2 — a specific variant is chosen: show the create form.
  if (variantId) {
    const v = await prisma.variant.findFirst({
      where: { id: variantId, status: "ACTIVE", product: { status: { in: ["ACTIVE", "DRAFT"] } } },
      select: {
        id: true,
        sku: true,
        price: true,
        compareAtPrice: true,
        product: { select: { name: true } },
        optionValues: {
          select: { optionValue: { select: { value: true, option: { select: { sortOrder: true } } } } },
        },
      },
    });
    if (!v) notFound();

    // Guard: the seller may already have a NEW offer for this variant.
    const existing = await prisma.offer.findUnique({
      where: { sellerId_variantId_condition: { sellerId: ctx.sellerId, variantId: v.id, condition: "NEW" } },
      select: { id: true },
    });

    const optionLabel =
      v.optionValues
        .slice()
        .sort((a, b) => a.optionValue.option.sortOrder - b.optionValue.option.sortOrder)
        .map((ov) => ov.optionValue.value)
        .join(" · ") || "Default";

    return (
      <div>
        <PageHeader title="New offer" />
        <Link
          href="/seller/offers/new"
          className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
        >
          <ArrowLeft size={14} /> Choose a different product
        </Link>

        <Card className="max-w-xl">
          <div className="mb-4 border-b border-line pb-4">
            <p className="text-sm font-semibold text-ink">{v.product.name}</p>
            <p className="text-xs text-ink-faint">
              {optionLabel} · {v.sku} · catalog price {pesos(v.price)}
            </p>
          </div>

          {existing ? (
            <div className="rounded-sm bg-warning-50 px-3 py-2 text-sm text-warning">
              You already have a “New” offer for this option.{" "}
              <Link href={`/seller/offers/${existing.id}`} className="underline">
                Open it
              </Link>
              .
            </div>
          ) : (
            <OfferCreateForm variantId={v.id} catalogPrice={v.price} catalogCompareAt={v.compareAtPrice} />
          )}
        </Card>
      </div>
    );
  }

  // Step 1 — pick a catalog variant.
  const variants = q ? await findListableVariants(ctx, { q, limit: 25 }) : [];

  return (
    <div>
      <PageHeader
        title="New offer"
        description="Pick the catalog product option you want to list. Axiaro owns the product; you set the price, condition and stock."
      />
      <Link
        href="/seller/offers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to My Offers
      </Link>

      <Card className="max-w-2xl">
        <form method="get" className="flex gap-2">
          <div className="relative flex-1">
            <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-faint" />
            <input
              type="search"
              name="q"
              defaultValue={q ?? ""}
              placeholder="Search catalog by product name or SKU…"
              className="field py-2 pl-9 text-sm"
              autoFocus
            />
          </div>
          <button type="submit" className="btn btn-outline py-2 text-sm">
            Search
          </button>
        </form>

        <div className="mt-4">
          {!q ? (
            <p className="py-6 text-center text-sm text-ink-faint">
              Search the catalog to find a product option to list against.
            </p>
          ) : variants.length === 0 ? (
            <EmptyState
              title="No matches"
              description="Nothing in the catalog matches — or you already list every match."
              compact
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {variants.map((v) => (
                <li key={v.variantId}>
                  <Link
                    href={`/seller/offers/new?variantId=${v.variantId}`}
                    className="flex items-center gap-3 px-1 py-3 text-sm hover:bg-surface-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{v.productName}</span>
                      <span className="block truncate text-xs text-ink-faint">
                        {v.optionLabel} · {v.sku}
                      </span>
                    </span>
                    <span className="tabular-nums text-ink-faint">{pesos(v.catalogPrice)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}
