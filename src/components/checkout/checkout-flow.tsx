"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Lock, ShoppingBag, MapPin, Truck, CreditCard, Check, Tag, X } from "lucide-react";
import { toast } from "sonner";
import { ProductImage } from "@/components/product-image";
import { Button, buttonClasses } from "@/components/ui/button";
import { RadioCard } from "@/components/ui/radio-card";
import { Field } from "@/components/ui/field";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { useCart } from "@/lib/cart-store";
import { placeOrder, startCheckoutPayment } from "@/lib/checkout-actions";
import { applyCoupon, removeCoupon } from "@/lib/cart-actions";
import { countryName } from "@/lib/countries";
import { formatPrice } from "@/lib/utils";
import type { CheckoutData } from "@/lib/checkout";
import type { AddressDTO } from "@/lib/addresses";

export function CheckoutFlow({ data }: { data: CheckoutData }) {
  const router = useRouter();
  const hydrate = useCart((s) => s.hydrate);

  const { summary, addresses, defaultShippingId, defaultBillingId, payment } = data;

  const showPayChoice = payment.cod && payment.online;
  const [shippingId, setShippingId] = useState<string | null>(defaultShippingId);
  const [sameForBilling, setSameForBilling] = useState(true);
  const [billingId, setBillingId] = useState<string | null>(defaultBillingId);
  const [methodId, setMethodId] = useState<string | null>(
    summary.shippingMethods[0]?.id ?? null,
  );
  // "cod" is the default when both channels are offered (preserves prior flow).
  const [payChoice, setPayChoice] = useState<"cod" | "online">(
    payment.online && !payment.cod ? "online" : "cod",
  );
  const goOnline = payment.online && (!payment.cod || payChoice === "online");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backToBag, setBackToBag] = useState(false);

  const shippingMethod = useMemo(
    () =>
      summary.shippingMethods.find((m) => m.id === methodId) ??
      summary.shippingMethods[0] ??
      null,
    [summary.shippingMethods, methodId],
  );
  const discount = summary.discountTotal;
  const total = Math.max(0, summary.subtotal - discount + (shippingMethod?.effectiveRate ?? 0));

  const effectiveBillingId = sameForBilling ? shippingId : billingId;
  const shipAddr = addresses.find((a) => a.id === shippingId) ?? null;
  const billAddr = addresses.find((a) => a.id === effectiveBillingId) ?? null;

  // ---- guard states -------------------------------------------------------
  if (summary.blocked) {
    const copy =
      summary.blocked === "EMPTY"
        ? "Your cart is empty."
        : summary.blocked === "UNAVAILABLE"
          ? "Some items in your cart are no longer available."
          : "Some quantities in your cart are more than we have in stock.";
    return (
      <EmptyState
        icon={<ShoppingBag size={24} />}
        title={copy}
        action={
          <Link href="/cart" className={buttonClasses()}>
            Return to cart
          </Link>
        }
      />
    );
  }

  if (addresses.length === 0) {
    return (
      <EmptyState
        icon={<MapPin size={24} />}
        title="Add a delivery address to check out"
        message="Your saved addresses are used for shipping and billing."
        action={
          <Link href="/account/addresses" className={buttonClasses()}>
            Add an address
          </Link>
        }
      />
    );
  }

  if (summary.shippingMethods.length === 0) {
    return (
      <EmptyState
        icon={<Truck size={24} />}
        title="No delivery methods are available right now"
        message="Please try again shortly."
      />
    );
  }

  async function submit() {
    setError(null);
    setBackToBag(false);
    if (!shippingId) {
      setError("Choose a shipping address.");
      return;
    }
    if (!sameForBilling && !billingId) {
      setError("Choose a billing address.");
      return;
    }
    if (!methodId) {
      setError("Choose a delivery method.");
      return;
    }
    setSubmitting(true);
    const res = await placeOrder({
      shippingAddressId: shippingId,
      billingAddressId: (sameForBilling ? shippingId : billingId) as string,
      shippingMethodId: methodId,
      note,
    });

    if (res.ok) {
      await hydrate();

      if (goOnline) {
        // The order exists (PENDING_PAYMENT). Start the PayMongo hosted checkout
        // and hand the browser to their page. The order is NOT marked paid here
        // — a verified webhook does that (Phase 6C).
        const pay = await startCheckoutPayment(res.orderNumber);
        if (pay.ok) {
          // Keep the button in its loading state until navigation happens.
          window.location.assign(pay.checkoutUrl);
          return;
        }
        setSubmitting(false);
        setConfirming(false);
        setError(
          `${pay.error} Your order ${res.orderNumber} is saved — you can complete payment from your orders.`,
        );
        return;
      }

      setSubmitting(false);
      toast.success(res.duplicate ? "Your order was already placed" : "Order placed");
      router.push(`/order/${res.orderNumber}`);
      return;
    }

    setSubmitting(false);
    setConfirming(false);
    setError(res.error);
    if (
      res.code === "STOCK" ||
      res.code === "EMPTY" ||
      res.code === "CART_GONE" ||
      res.code === "SELLER"
    ) {
      setBackToBag(true);
    }
    if (res.code === "SHIPPING" || res.code === "COUPON") {
      // The method list / coupon may be stale — reload the page's server data.
      router.refresh();
    }
  }

  return (
    <div className="grid gap-10 lg:grid-cols-[1fr_380px]">
      <div className="space-y-10">
        {summary.pricesChanged && (
          <p className="rounded-sm border border-clay/30 bg-clay-50 px-4 py-3 text-sm text-clay">
            Some prices changed since you added these items. The totals shown are current.
          </p>
        )}

        <Section step={1} icon={<MapPin size={15} />} title="Shipping address">
          <AddressRadioList
            addresses={addresses}
            selectedId={shippingId}
            onSelect={setShippingId}
            markerFor="shipping"
          />
        </Section>

        <Section step={2} icon={<CreditCard size={15} />} title="Billing address">
          <label className="mb-3 flex items-center gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={sameForBilling}
              onChange={(e) => setSameForBilling(e.target.checked)}
              className="accent-ink"
            />
            Same as shipping address
          </label>
          {!sameForBilling && (
            <AddressRadioList
              addresses={addresses}
              selectedId={billingId}
              onSelect={setBillingId}
              markerFor="billing"
            />
          )}
        </Section>

        <Section step={3} icon={<Truck size={15} />} title="Delivery method">
          <div className="space-y-3">
            {summary.shippingMethods.map((m) => (
              <RadioCard
                key={m.id}
                name="delivery"
                value={m.id}
                checked={methodId === m.id}
                onSelect={() => setMethodId(m.id)}
                className="items-center"
              >
                <span className="flex flex-1 items-center justify-between gap-3">
                  <span>
                    <span className="block text-sm font-medium">{m.name}</span>
                    {m.description && (
                      <span className="block text-meta text-ink-faint">{m.description}</span>
                    )}
                  </span>
                  <span className="shrink-0 text-sm font-medium tabular-nums">
                    {m.effectiveRate === 0 ? "Free" : formatPrice(m.effectiveRate)}
                    {m.freeApplied && (
                      <span className="ml-1 text-meta font-normal text-ink-faint line-through">
                        {formatPrice(m.rate)}
                      </span>
                    )}
                  </span>
                </span>
              </RadioCard>
            ))}
          </div>
        </Section>

        <Section step={4} icon={<Lock size={15} />} title="Payment">
          {showPayChoice && (
            <div className="mb-3 space-y-2.5">
              <RadioCard
                name="pay-method"
                value="cod"
                checked={payChoice === "cod"}
                onSelect={() => setPayChoice("cod")}
                align="start"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">Pay on delivery</span>
                  <span className="block text-meta text-ink-faint">
                    Place your order now — pay when it arrives.
                  </span>
                </span>
              </RadioCard>
              <RadioCard
                name="pay-method"
                value="online"
                checked={payChoice === "online"}
                onSelect={() => setPayChoice("online")}
                align="start"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium">
                    Pay online ({formatMethods(payment.methods)})
                  </span>
                  <span className="block text-meta text-ink-faint">
                    You’ll be taken to our secure payment page.
                  </span>
                </span>
              </RadioCard>
            </div>
          )}

          {goOnline ? (
            <div className="space-y-2">
              <p className="rounded-sm bg-surface-sunken px-3 py-2.5 text-sm text-ink-soft">
                <span className="font-medium text-ink">
                  You’ll be taken to our secure payment page
                </span>{" "}
                to pay by {formatMethods(payment.methods)}. Your order is held until payment is
                confirmed.
              </p>
              {payment.testMode && (
                <p className="rounded-sm border border-warning/30 bg-warning-50 px-3 py-2 text-meta font-medium text-warning">
                  Test mode — no real charge is made.
                </p>
              )}
            </div>
          ) : (
            <p className="rounded-sm bg-surface-sunken px-3 py-2.5 text-sm text-ink-soft">
              <span className="font-medium text-ink">You’ll pay on delivery.</span> Place your order
              now — our team confirms it and arranges payment before dispatch.
            </p>
          )}
          <Field label="Order note" className="mt-4">
            {(control) => (
              <textarea
                {...control}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                maxLength={500}
                placeholder="Delivery instructions (optional)"
                className="field resize-none"
              />
            )}
          </Field>
        </Section>
      </div>

      {/* Summary + review */}
      <aside className="lg:sticky lg:top-28 lg:h-fit">
        <div className="card-surface p-5">
          <h2 className="text-subtitle">Your order</h2>
          <ul className="mt-4 max-h-64 space-y-3 overflow-y-auto pr-1">
            {summary.lines.map((l) => (
              <li key={l.variantId} className="flex gap-3">
                <div className="relative h-14 w-12 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                  <ProductImage src={l.imageUrl} alt={l.name} compact sizes="48px" />
                  <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-micro font-semibold text-paper">
                    {l.quantity}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">{l.name}</p>
                  {l.optionSummary && (
                    <p className="text-meta text-ink-faint">{l.optionSummary}</p>
                  )}
                  <p className="text-micro text-ink-faint">SKU {l.sku}</p>
                </div>
                <span className="text-sm tabular-nums">{formatPrice(l.lineTotal)}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-line pt-4">
            <CheckoutCouponField coupon={summary.coupon} />
          </div>

          <dl className="mt-5 space-y-2 text-sm">
            <Row label={`Subtotal (${summary.itemCount} item${summary.itemCount === 1 ? "" : "s"})`} value={formatPrice(summary.subtotal)} />
            {discount > 0 && (
              <div className="flex items-baseline justify-between text-sage">
                <dt>Discount{summary.coupon ? ` · ${summary.coupon.code}` : ""}</dt>
                <dd className="tabular-nums">−{formatPrice(discount)}</dd>
              </div>
            )}
            <Row
              label={shippingMethod ? `Shipping · ${shippingMethod.name}` : "Shipping"}
              value={(shippingMethod?.effectiveRate ?? 0) === 0 ? "Free" : formatPrice(shippingMethod!.effectiveRate)}
            />
            <div className="!mt-3 flex items-baseline justify-between border-t border-line pt-3">
              <dt className="font-medium">Total</dt>
              <dd className="font-display text-subtitle">{formatPrice(total)}</dd>
            </div>
          </dl>

          {error && (
            <div className="mt-4 rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
              <p>{error}</p>
              {backToBag && (
                <Link href="/cart" className="mt-1 inline-block font-medium underline">
                  Return to cart
                </Link>
              )}
            </div>
          )}

          {confirming ? (
            <div className="mt-5 space-y-3 rounded-md border border-line bg-surface p-4 text-sm">
              <p className="font-medium">Review &amp; confirm</p>
              <ReviewLine label="Ship to" addr={shipAddr} />
              <ReviewLine label="Bill to" addr={billAddr} />
              <p className="text-ink-soft">
                {summary.itemCount} item{summary.itemCount === 1 ? "" : "s"} ·{" "}
                {shippingMethod?.name} ·{" "}
                <span className="font-medium text-ink">{formatPrice(total)}</span>
              </p>
              <div className="flex gap-2 pt-1">
                <Button onClick={submit} loading={submitting} className="flex-1">
                  {!submitting && <Check size={15} />}
                  {goOnline
                    ? submitting
                      ? "Redirecting to payment…"
                      : "Place order & pay"
                    : "Place order"}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                  disabled={submitting}
                >
                  Back
                </Button>
              </div>
            </div>
          ) : (
            <Button
              onClick={() => {
                setError(null);
                if (!shippingId) return setError("Choose a shipping address.");
                if (!sameForBilling && !billingId) return setError("Choose a billing address.");
                setConfirming(true);
              }}
              className="mt-5 w-full"
            >
              <Lock size={15} /> Review order
            </Button>
          )}

          <p className="mt-3 text-center text-meta text-ink-faint">
            By placing your order you agree to our{" "}
            <Link href="/pages/terms" className="underline">
              Terms
            </Link>
            .
          </p>
        </div>
      </aside>
    </div>
  );
}

/** "card" / "gcash" → "card or GCash", "card, GCash or Atome". Display only. */
function formatMethods(methods: string[]): string {
  const label = (m: string) =>
    m === "gcash" ? "GCash" : m === "grab_pay" ? "GrabPay" : m === "card" ? "card" : m;
  const names = methods.map(label);
  if (names.length <= 1) return names[0] ?? "card";
  return `${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}`;
}

function AddressRadioList({
  addresses,
  selectedId,
  onSelect,
  markerFor,
}: {
  addresses: AddressDTO[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  markerFor: "shipping" | "billing";
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {addresses.map((a) => {
          const isDefault = markerFor === "shipping" ? a.defaultShipping : a.defaultBilling;
          return (
            <RadioCard
              key={a.id}
              name={`addr-${markerFor}`}
              value={a.id}
              checked={selectedId === a.id}
              onSelect={onSelect}
              align="start"
            >
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="text-micro font-semibold uppercase tracking-wider text-ink-faint">
                    {a.label}
                  </span>
                  {isDefault && <Badge tone="neutral">Default</Badge>}
                </span>
                <span className="mt-1 block font-medium">
                  {a.firstName} {a.lastName}
                </span>
                <span className="mt-0.5 block text-meta text-ink-soft">
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ""}
                  <br />
                  {[a.barangay, a.city, a.province, a.postalCode].filter(Boolean).join(", ")}
                  <br />
                  {countryName(a.country)} · {a.phone}
                </span>
              </span>
            </RadioCard>
          );
        })}
      </div>
      <Link
        href="/account/addresses"
        className="inline-block text-meta font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
      >
        Add or manage addresses
      </Link>
    </div>
  );
}

function ReviewLine({ label, addr }: { label: string; addr: AddressDTO | null }) {
  return (
    <p className="text-ink-soft">
      <span className="text-ink-faint">{label}: </span>
      {addr
        ? `${addr.firstName} ${addr.lastName}, ${addr.line1}, ${[addr.city, addr.province, addr.postalCode]
            .filter(Boolean)
            .join(", ")}`
        : "—"}
    </p>
  );
}

function Section({
  step,
  icon,
  title,
  children,
}: {
  step: number;
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-4 flex items-center gap-3 text-subtitle">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-micro font-semibold text-paper">
          {step}
        </span>
        <span className="flex items-center gap-2">
          {icon}
          {title}
        </span>
      </h2>
      {children}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function CheckoutCouponField({
  coupon,
}: {
  coupon: CheckoutData["summary"]["coupon"];
}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  async function apply() {
    if (!code.trim() || busy) return;
    setBusy(true);
    const res = await applyCoupon({ code });
    setBusy(false);
    if (res.ok) {
      setCode("");
      toast.success(res.notice ?? "Coupon applied");
    } else {
      toast.error(res.error ?? "That code isn’t valid");
    }
    router.refresh();
  }

  async function remove() {
    setBusy(true);
    await removeCoupon();
    setBusy(false);
    router.refresh();
  }

  if (coupon?.valid) {
    return (
      <div className="flex items-center justify-between rounded-sm border border-sage/40 bg-sage-50 px-3 py-2.5 text-sm">
        <span className="inline-flex items-center gap-2 font-medium text-sage">
          <Tag size={14} /> {coupon.code} · −{formatPrice(coupon.discount)}
        </span>
        <button onClick={remove} disabled={busy} className="grid tap place-items-center text-ink-faint hover:text-ink" aria-label="Remove coupon">
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              apply();
            }
          }}
          placeholder="Promo code"
          className="field !py-2.5 text-sm uppercase"
          aria-label="Promo code"
        />
        <Button type="button" variant="outline" size="sm" onClick={apply} loading={busy} className="shrink-0">
          Apply
        </Button>
      </div>
      {coupon && !coupon.valid && coupon.error && (
        <p className="text-meta text-clay">
          {coupon.code}: {coupon.error}{" "}
          <button onClick={remove} className="underline">
            Remove
          </button>
        </p>
      )}
    </div>
  );
}
