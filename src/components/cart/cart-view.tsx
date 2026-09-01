"use client";

import Link from "next/link";
import { Minus, Plus, Trash2, ShoppingBag, ArrowRight, AlertTriangle } from "lucide-react";
import { ProductImage } from "@/components/product-image";
import { PriceTag } from "@/components/ui/primitives";
import { CouponField } from "@/components/cart/coupon-field";
import { OrderSummaryLines } from "@/components/cart/order-summary";
import { useCart } from "@/lib/cart-store";
import { formatPrice } from "@/lib/utils";
import { useStorefrontConfig } from "@/components/storefront-config-provider";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { computeTotals } from "@/lib/pricing";

export function CartView() {
  const lines = useCart((s) => s.lines);
  const hydrated = useCart((s) => s.hydrated);
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.removeItem);

  const config = useStorefrontConfig();
  const purchasable = lines.filter((l) => !l.unavailable);
  const totals = computeTotals({
    lines: purchasable.map((l) => ({
      unitPrice: l.unitPrice,
      quantity: Math.min(l.quantity, l.available),
    })),
    shipping: { freeThreshold: config.freeShippingThreshold, methods: config.shippingMethods },
  });
  const freeShipPct =
    config.freeShippingThreshold > 0
      ? Math.min(100, Math.round((totals.subtotal / config.freeShippingThreshold) * 100))
      : 100;

  if (!hydrated) {
    return <Skeleton className="h-64 rounded-lg" />;
  }

  if (lines.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag size={24} />}
        title="Your bag is empty"
        message="Browse the catalogue and add a few pieces — they'll show up here."
        action={
          <Link href="/c/all" className={buttonClasses()}>
            Start shopping
          </Link>
        }
      />
    );
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_360px]">
      <div>
        {!totals.freeShippingApplied ? (
          <div className="mb-6 rounded-md border border-line bg-surface p-4">
            <p className="text-sm text-ink-soft">
              Add{" "}
              <span className="font-semibold text-ink">
                {formatPrice(totals.amountToFreeShipping)}
              </span>{" "}
              more for free standard shipping
            </p>
            <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className="h-full rounded-full bg-clay transition-all duration-500"
                style={{ width: `${freeShipPct}%` }}
              />
            </div>
          </div>
        ) : (
          <div className="mb-6 rounded-md bg-sage-50 px-4 py-3 text-sm font-medium text-sage">
            Your order qualifies for free standard shipping.
          </div>
        )}

        <ul className="divide-y divide-line border-y border-line">
          {lines.map((l) => (
            <li key={l.key} className="flex gap-4 py-5">
              <Link
                href={`/p/${l.slug}`}
                className="h-28 w-24 shrink-0 overflow-hidden rounded-sm bg-surface-sunken"
              >
                <ProductImage src={l.imageUrl} alt={l.name} />
              </Link>
              <div className="flex min-w-0 flex-1 flex-col">
                <div className="flex justify-between gap-3">
                  <div>
                    <Link href={`/p/${l.slug}`} className="text-[15px] font-medium">
                      {l.name}
                    </Link>
                    {l.optionSummary && (
                      <p className="mt-0.5 text-sm text-ink-faint">{l.optionSummary}</p>
                    )}
                    <p className="mt-0.5 text-xs text-ink-faint">SKU {l.sku}</p>
                  </div>
                  <PriceTag price={l.unitPrice} compareAt={l.compareAtPrice} size="sm" />
                </div>

                {l.unavailable ? (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-sale">
                    <AlertTriangle size={14} /> No longer available
                  </p>
                ) : (
                  l.overStock && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-clay">
                      <AlertTriangle size={14} /> Only {l.available} left — quantity will be adjusted
                    </p>
                  )
                )}

                <div className="mt-auto flex items-center justify-between pt-3">
                  {l.unavailable ? (
                    <span className="text-sm text-ink-faint">—</span>
                  ) : (
                    <div className="inline-flex items-center rounded-sm border border-line-strong">
                      <button
                        onClick={() => setQuantity(l.variantId, l.quantity - 1)}
                        disabled={l.quantity <= 1}
                        className="grid h-9 w-9 tap place-items-center text-ink-soft hover:text-ink disabled:opacity-30"
                        aria-label="Decrease quantity"
                      >
                        <Minus size={14} />
                      </button>
                      <span className="w-9 text-center text-sm font-medium tabular-nums">
                        {l.quantity}
                      </span>
                      <button
                        onClick={() => setQuantity(l.variantId, l.quantity + 1)}
                        disabled={l.quantity >= l.available}
                        className="grid h-9 w-9 tap place-items-center text-ink-soft hover:text-ink disabled:opacity-30"
                        aria-label="Increase quantity"
                      >
                        <Plus size={14} />
                      </button>
                    </div>
                  )}

                  <div className="flex items-center gap-4">
                    {!l.unavailable && (
                      <span className="text-[15px] font-medium tabular-nums">
                        {formatPrice(l.unitPrice * Math.min(l.quantity, l.available))}
                      </span>
                    )}
                    <button
                      onClick={() => remove(l.variantId)}
                      className="grid tap place-items-center text-ink-faint hover:text-sale"
                      aria-label={`Remove ${l.name}`}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              </div>
            </li>
          ))}
        </ul>

        <Link
          href="/c/all"
          className="mt-6 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
        >
          ← Continue shopping
        </Link>
      </div>

      <aside className="lg:sticky lg:top-28 lg:h-fit">
        <div className="card-surface p-5">
          <h2 className="text-lg">Order summary</h2>
          <div className="mt-4">
            <CouponField />
          </div>
          <div className="mt-5">
            <OrderSummaryLines />
          </div>
          <Link
            href="/checkout"
            className={buttonClasses({ className: "mt-5 w-full aria-disabled:pointer-events-none aria-disabled:opacity-50" })}
            aria-disabled={purchasable.length === 0}
          >
            Checkout <ArrowRight size={16} />
          </Link>
          <p className="mt-3 text-center text-xs text-ink-faint">
            Taxes included where applicable. Secure checkout.
          </p>
        </div>
      </aside>
    </div>
  );
}
