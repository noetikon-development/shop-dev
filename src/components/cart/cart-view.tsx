"use client";

import Link from "next/link";
import { Trash2, ShoppingBag, ArrowRight, ArrowLeft, AlertTriangle } from "lucide-react";
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
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { FreeShippingMeter } from "@/components/ui/free-shipping-meter";
import { computeTotals } from "@/lib/pricing";

export function CartView() {
  const lines = useCart((s) => s.lines);
  const sellerGroups = useCart((s) => s.sellerGroups);
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
  if (!hydrated) {
    return <Skeleton className="h-64 rounded-lg" />;
  }

  if (lines.length === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag size={24} />}
        title="Your cart is empty"
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
        <FreeShippingMeter
          subtotal={totals.subtotal}
          threshold={config.freeShippingThreshold}
          applied={totals.freeShippingApplied}
          remaining={totals.amountToFreeShipping}
          className="mb-6"
        />

        <div className="border-y border-line">
          {sellerGroups.map((group) => (
            <section key={group.sellerId} className="border-b border-line last:border-b-0">
              <div className="flex items-baseline justify-between pt-5 pb-1">
                <h2 className="text-meta font-medium uppercase tracking-wide text-ink-soft">
                  Sold by {group.sellerName}
                </h2>
                <span className="text-meta text-ink-faint tabular-nums">
                  {formatPrice(group.merchandiseSubtotal)}
                </span>
              </div>
              <ul className="divide-y divide-line">
                {group.lines.map((l) => (
                  <li key={l.key} className="flex gap-4 py-5">
                    <Link
                      href={`/p/${l.slug}`}
                      className="h-28 w-24 shrink-0 overflow-hidden rounded-sm bg-surface-sunken"
                    >
                      <ProductImage src={l.imageUrl} alt={l.name} compact sizes="96px" />
                    </Link>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex justify-between gap-3">
                        <div>
                          <Link href={`/p/${l.slug}`} className="text-body font-medium">
                            {l.name}
                          </Link>
                          {l.optionSummary && (
                            <p className="mt-0.5 text-meta text-ink-soft">{l.optionSummary}</p>
                          )}
                          <p className="mt-0.5 text-micro text-ink-faint">SKU {l.sku}</p>
                        </div>
                        <PriceTag price={l.unitPrice} compareAt={l.compareAtPrice} size="sm" />
                      </div>

                      {l.unavailable ? (
                        <p className="mt-2 inline-flex items-center gap-1.5 text-meta font-medium text-sale">
                          <AlertTriangle size={14} /> No longer available
                        </p>
                      ) : (
                        l.overStock && (
                          <p className="mt-2 inline-flex items-center gap-1.5 text-meta font-medium text-clay">
                            <AlertTriangle size={14} /> Only {l.available} left — quantity will be adjusted
                          </p>
                        )
                      )}

                      <div className="mt-auto flex items-center justify-between pt-3">
                        {l.unavailable ? (
                          <span className="text-meta text-ink-faint">—</span>
                        ) : (
                          <QuantityStepper
                            value={l.quantity}
                            onChange={(n) => setQuantity(l.key, n)}
                            max={l.available}
                            size="sm"
                            ariaLabel={`Quantity — ${l.name}`}
                          />
                        )}

                        <div className="flex items-center gap-4">
                          {!l.unavailable && (
                            <span className="text-body font-medium tabular-nums">
                              {formatPrice(l.unitPrice * Math.min(l.quantity, l.available))}
                            </span>
                          )}
                          <button
                            onClick={() => remove(l.key)}
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
            </section>
          ))}
        </div>

        <Link
          href="/c/all"
          className="mt-6 inline-flex items-center gap-1.5 text-meta font-medium text-ink-soft hover:text-ink"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Continue shopping
        </Link>
      </div>

      <aside className="lg:sticky lg:top-28 lg:h-fit">
        <div className="card-surface p-5 sm:p-6">
          <h2 className="text-subtitle">Order summary</h2>
          <div className="mt-4">
            <CouponField />
          </div>
          <div className="mt-5">
            <OrderSummaryLines />
          </div>
          <Link
            href="/checkout"
            className={buttonClasses({
              size: "lg",
              className:
                "mt-6 w-full aria-disabled:pointer-events-none aria-disabled:opacity-50",
            })}
            aria-disabled={purchasable.length === 0}
          >
            Checkout <ArrowRight size={16} />
          </Link>
          <p className="mt-3 text-center text-meta text-ink-faint">
            Taxes included where applicable. Secure checkout.
          </p>
        </div>
      </aside>
    </div>
  );
}
