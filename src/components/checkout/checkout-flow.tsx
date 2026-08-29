"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Lock, ShoppingBag, MapPin, Truck, CreditCard, Check } from "lucide-react";
import { toast } from "sonner";
import { ProductImage } from "@/components/product-image";
import { useCart } from "@/lib/cart-store";
import { placeOrder } from "@/lib/checkout-actions";
import { countryName } from "@/lib/countries";
import { formatPrice, cn } from "@/lib/utils";
import type { CheckoutData, ShippingMethodId } from "@/lib/checkout";
import type { AddressDTO } from "@/lib/addresses";

export function CheckoutFlow({ data }: { data: CheckoutData }) {
  const router = useRouter();
  const hydrate = useCart((s) => s.hydrate);

  const { summary, addresses, defaultShippingId, defaultBillingId } = data;

  const [shippingId, setShippingId] = useState<string | null>(defaultShippingId);
  const [sameForBilling, setSameForBilling] = useState(true);
  const [billingId, setBillingId] = useState<string | null>(defaultBillingId);
  const [method, setMethod] = useState<ShippingMethodId>("standard");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backToBag, setBackToBag] = useState(false);

  const shippingOption = useMemo(
    () => summary.shippingOptions.find((o) => o.id === method) ?? summary.shippingOptions[0],
    [summary.shippingOptions, method],
  );
  const total = summary.subtotal + (shippingOption?.effectiveFee ?? 0);

  const effectiveBillingId = sameForBilling ? shippingId : billingId;
  const shipAddr = addresses.find((a) => a.id === shippingId) ?? null;
  const billAddr = addresses.find((a) => a.id === effectiveBillingId) ?? null;

  // ---- guard states -------------------------------------------------------
  if (summary.blocked) {
    const copy =
      summary.blocked === "EMPTY"
        ? "Your bag is empty."
        : summary.blocked === "UNAVAILABLE"
          ? "Some items in your bag are no longer available."
          : "Some quantities in your bag are more than we have in stock.";
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong py-20 text-center">
        <ShoppingBag size={22} className="text-ink-faint" />
        <p className="mt-4 font-medium">{copy}</p>
        <Link href="/cart" className="btn btn-primary mt-5">
          Return to bag
        </Link>
      </div>
    );
  }

  if (addresses.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong py-20 text-center">
        <MapPin size={22} className="text-ink-faint" />
        <p className="mt-4 font-medium">Add a delivery address to check out</p>
        <p className="mt-1 max-w-sm text-sm text-ink-soft">
          Your saved addresses are used for shipping and billing.
        </p>
        <Link href="/account/addresses" className="btn btn-primary mt-5">
          Add an address
        </Link>
      </div>
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
    setSubmitting(true);
    const res = await placeOrder({
      shippingAddressId: shippingId,
      billingAddressId: (sameForBilling ? shippingId : billingId) as string,
      shippingMethod: method,
      note,
    });
    setSubmitting(false);

    if (res.ok) {
      await hydrate();
      toast.success(res.duplicate ? "Your order was already placed" : "Order placed");
      router.push(`/order/${res.orderNumber}`);
      return;
    }

    setConfirming(false);
    setError(res.error);
    if (res.code === "STOCK" || res.code === "EMPTY" || res.code === "CART_GONE") {
      setBackToBag(true);
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
            {summary.shippingOptions.map((o) => (
              <label
                key={o.id}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-md border p-4 transition-colors",
                  method === o.id ? "border-ink bg-surface" : "border-line-strong",
                )}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="delivery"
                    checked={method === o.id}
                    onChange={() => setMethod(o.id)}
                    className="accent-ink"
                  />
                  <span>
                    <span className="block text-sm font-medium">{o.label}</span>
                    <span className="block text-xs text-ink-faint">{o.detail}</span>
                  </span>
                </span>
                <span className="text-sm font-medium tabular-nums">
                  {o.effectiveFee === 0 ? "Free" : formatPrice(o.effectiveFee)}
                </span>
              </label>
            ))}
          </div>
        </Section>

        <Section step={4} icon={<Lock size={15} />} title="Payment">
          <p className="rounded-sm bg-surface-sunken px-3 py-2.5 text-sm text-ink-soft">
            Payment isn’t available yet. Your order will be placed as{" "}
            <span className="font-medium text-ink">awaiting payment</span> — you’ll be able to pay
            in a later step.
          </p>
          <label className="mt-4 block">
            <span className="mb-1.5 block text-sm font-medium">Order note</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder="Delivery instructions (optional)"
              className="field resize-none"
            />
          </label>
        </Section>
      </div>

      {/* Summary + review */}
      <aside className="lg:sticky lg:top-28 lg:h-fit">
        <div className="card-surface p-5">
          <h2 className="text-lg">Your order</h2>
          <ul className="mt-4 max-h-64 space-y-3 overflow-y-auto pr-1">
            {summary.lines.map((l) => (
              <li key={l.variantId} className="flex gap-3">
                <div className="relative h-14 w-12 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                  <ProductImage src={l.imageUrl} alt={l.name} />
                  <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-[10px] font-semibold text-paper">
                    {l.quantity}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">{l.name}</p>
                  {l.optionSummary && (
                    <p className="text-xs text-ink-faint">{l.optionSummary}</p>
                  )}
                  <p className="text-xs text-ink-faint">SKU {l.sku}</p>
                </div>
                <span className="text-sm tabular-nums">{formatPrice(l.lineTotal)}</span>
              </li>
            ))}
          </ul>

          <dl className="mt-4 space-y-2 border-t border-line pt-4 text-sm">
            <Row label={`Subtotal (${summary.itemCount} item${summary.itemCount === 1 ? "" : "s"})`} value={formatPrice(summary.subtotal)} />
            <Row
              label="Shipping"
              value={(shippingOption?.effectiveFee ?? 0) === 0 ? "Free" : formatPrice(shippingOption!.effectiveFee)}
            />
            <div className="!mt-3 flex items-baseline justify-between border-t border-line pt-3">
              <dt className="font-medium">Total</dt>
              <dd className="font-display text-xl">{formatPrice(total)}</dd>
            </div>
          </dl>

          {error && (
            <div className="mt-4 rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
              <p>{error}</p>
              {backToBag && (
                <Link href="/cart" className="mt-1 inline-block font-medium underline">
                  Return to bag
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
                {shippingOption?.label} ·{" "}
                <span className="font-medium text-ink">{formatPrice(total)}</span>
              </p>
              <div className="flex gap-2 pt-1">
                <button
                  onClick={submit}
                  disabled={submitting}
                  className="btn btn-primary flex-1"
                >
                  {submitting ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                  Place order
                </button>
                <button
                  onClick={() => setConfirming(false)}
                  disabled={submitting}
                  className="btn btn-ghost"
                >
                  Back
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => {
                setError(null);
                if (!shippingId) return setError("Choose a shipping address.");
                if (!sameForBilling && !billingId) return setError("Choose a billing address.");
                setConfirming(true);
              }}
              className="btn btn-primary mt-5 w-full"
            >
              <Lock size={15} /> Review order
            </button>
          )}

          <p className="mt-3 text-center text-xs text-ink-faint">
            By placing your order you agree to our{" "}
            <Link href="/legal/terms" className="underline">
              Terms
            </Link>
            .
          </p>
        </div>
      </aside>
    </div>
  );
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
            <label
              key={a.id}
              className={cn(
                "flex cursor-pointer gap-3 rounded-md border p-3.5 text-sm transition-colors",
                selectedId === a.id ? "border-ink bg-surface" : "border-line-strong",
              )}
            >
              <input
                type="radio"
                name={`addr-${markerFor}`}
                checked={selectedId === a.id}
                onChange={() => onSelect(a.id)}
                className="mt-0.5 accent-ink"
              />
              <span className="min-w-0">
                <span className="flex items-center gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                    {a.label}
                  </span>
                  {isDefault && (
                    <span className="rounded-full bg-ink px-1.5 py-0.5 text-[9px] font-medium text-paper">
                      Default
                    </span>
                  )}
                </span>
                <span className="mt-1 block font-medium">
                  {a.firstName} {a.lastName}
                </span>
                <span className="block text-ink-soft">
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ""}
                  <br />
                  {[a.barangay, a.city, a.province, a.postalCode].filter(Boolean).join(", ")}
                  <br />
                  {countryName(a.country)} · {a.phone}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <Link
        href="/account/addresses"
        className="inline-block text-xs font-medium text-ink-soft underline underline-offset-2 hover:text-ink"
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
      <h2 className="mb-4 flex items-center gap-3 text-lg">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-xs font-semibold text-paper">
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
