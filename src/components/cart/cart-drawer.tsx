"use client";

import Link from "next/link";
import { Trash2, ShoppingBag, AlertTriangle } from "lucide-react";
import { SlideOver } from "@/components/ui/slide-over";
import { ProductImage } from "@/components/product-image";
import { useCart } from "@/lib/cart-store";
import { useUI } from "@/lib/ui-store";
import { computeTotals } from "@/lib/pricing";
import { formatPrice } from "@/lib/utils";
import { useStorefrontConfig } from "@/components/storefront-config-provider";
import { Button, buttonClasses } from "@/components/ui/button";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { FreeShippingMeter } from "@/components/ui/free-shipping-meter";

export function CartDrawer() {
  const { cartOpen, closeCart } = useUI();
  const lines = useCart((s) => s.lines);
  const coupon = useCart((s) => s.coupon);
  const setQuantity = useCart((s) => s.setQuantity);
  const remove = useCart((s) => s.removeItem);

  const config = useStorefrontConfig();
  const purchasable = lines.filter((l) => !l.unavailable);
  const totals = computeTotals({
    lines: purchasable.map((l) => ({
      unitPrice: l.unitPrice,
      quantity: Math.min(l.quantity, l.available),
    })),
    discount: coupon?.valid ? coupon.discount : 0,
    couponCode: coupon?.code ?? null,
    shipping: { freeThreshold: config.freeShippingThreshold, methods: config.shippingMethods },
  });

  return (
    <SlideOver
      open={cartOpen}
      onClose={closeCart}
      title={`Your bag (${totals.itemCount})`}
      footer={
        lines.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-soft">Subtotal</span>
              <span className="font-medium tabular-nums">{formatPrice(totals.subtotal)}</span>
            </div>
            {totals.discountTotal > 0 && (
              <div className="flex items-center justify-between text-sm text-success">
                <span>Discount ({totals.couponApplied})</span>
                <span className="tabular-nums">−{formatPrice(totals.discountTotal)}</span>
              </div>
            )}
            <p className="text-xs text-ink-faint">
              Shipping &amp; taxes calculated at checkout.
            </p>
            {purchasable.length > 0 ? (
              <Link
                href="/checkout"
                onClick={closeCart}
                className={buttonClasses({ className: "w-full" })}
              >
                Checkout · {formatPrice(totals.grandTotal)}
              </Link>
            ) : (
              <Button disabled className="w-full">
                Checkout
              </Button>
            )}
            <Link
              href="/cart"
              onClick={closeCart}
              className="block text-center text-xs font-medium text-ink-soft underline underline-offset-4"
            >
              View full bag
            </Link>
          </div>
        ) : null
      }
    >
      {lines.length === 0 ? (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
          <div className="grid h-16 w-16 place-items-center rounded-full bg-surface-sunken">
            <ShoppingBag size={24} className="text-ink-faint" />
          </div>
          <div>
            <p className="font-medium">Your bag is empty</p>
            <p className="mt-1 text-sm text-ink-faint">
              Saved pieces and past orders live in your account.
            </p>
          </div>
          <Button variant="outline" onClick={closeCart}>
            Continue shopping
          </Button>
        </div>
      ) : (
        <div className="px-5 py-4">
          <FreeShippingMeter
            subtotal={totals.subtotal}
            threshold={config.freeShippingThreshold}
            applied={totals.freeShippingApplied}
            remaining={totals.amountToFreeShipping}
            size="sm"
            className="mb-4"
          />

          <ul className="divide-y divide-line">
            {lines.map((l) => (
              <li key={l.key} className="flex gap-3 py-4">
                <Link
                  href={`/p/${l.slug}`}
                  onClick={closeCart}
                  className="h-20 w-16 shrink-0 overflow-hidden rounded-sm bg-surface-sunken"
                >
                  <ProductImage src={l.imageUrl} alt={l.name} />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="flex justify-between gap-2">
                    <Link
                      href={`/p/${l.slug}`}
                      onClick={closeCart}
                      className="line-clamp-2 text-sm font-medium"
                    >
                      {l.name}
                    </Link>
                    <button
                      onClick={() => remove(l.variantId)}
                      aria-label="Remove"
                      className="shrink-0 grid tap place-items-center text-ink-faint hover:text-sale"
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                  {l.optionSummary && (
                    <p className="mt-0.5 text-xs text-ink-faint">{l.optionSummary}</p>
                  )}

                  {l.unavailable ? (
                    <p className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-sale">
                      <AlertTriangle size={12} /> No longer available
                    </p>
                  ) : (
                    <div className="mt-2 flex items-center justify-between">
                      <QuantityStepper
                        value={l.quantity}
                        onChange={(n) => setQuantity(l.variantId, n)}
                        max={l.available}
                        size="sm"
                        ariaLabel={`Quantity — ${l.name}`}
                      />
                      <span className="text-sm font-medium tabular-nums">
                        {formatPrice(l.unitPrice * Math.min(l.quantity, l.available))}
                      </span>
                    </div>
                  )}
                  {!l.unavailable && l.overStock && (
                    <p className="mt-1.5 text-xs font-medium text-clay">
                      Only {l.available} left in stock
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </SlideOver>
  );
}
