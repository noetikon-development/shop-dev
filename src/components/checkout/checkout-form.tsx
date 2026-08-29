"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Lock, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { ProductImage } from "@/components/product-image";
import { CouponField } from "@/components/cart/coupon-field";
import { OrderSummaryLines } from "@/components/cart/order-summary";
import { useCart } from "@/lib/cart-store";
import { placeOrder, type CheckoutInput } from "@/lib/actions";
import { SHIPPING_METHODS, PAYMENT_METHODS } from "@/lib/constants";
import { formatPrice, cn } from "@/lib/utils";

type Prefill = {
  email: string;
  phone: string;
  address: Partial<CheckoutInput["address"]>;
  signedIn: boolean;
};

export function CheckoutForm({ prefill }: { prefill: Prefill }) {
  const router = useRouter();
  const lines = useCart((s) => s.lines);
  const coupon = useCart((s) => s.coupon);
  const hydrated = useCart((s) => s.hydrated);
  const clear = useCart((s) => s.clear);

  const [shippingMethod, setShippingMethod] = useState<"standard" | "express">("standard");
  const [paymentMethod, setPaymentMethod] = useState<"COD" | "CARD" | "GCASH">("COD");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    email: prefill.email,
    phone: prefill.phone,
    recipient: prefill.address.recipient ?? "",
    line1: prefill.address.line1 ?? "",
    line2: prefill.address.line2 ?? "",
    barangay: prefill.address.barangay ?? "",
    city: prefill.address.city ?? "",
    province: prefill.address.province ?? "",
    region: prefill.address.region ?? "",
    postalCode: prefill.address.postalCode ?? "",
    note: "",
    saveAddress: prefill.signedIn,
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value }));

  const itemsForOrder = useMemo(
    () =>
      lines
        .filter((l) => !l.unavailable)
        .map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: Math.min(l.quantity, l.available),
        })),
    [lines],
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (lines.some((l) => l.unavailable)) {
      setError(
        "Some items in your bag are no longer available. Please remove them to continue.",
      );
      return;
    }
    if (itemsForOrder.length === 0) {
      setError("Your bag has no items available to order.");
      return;
    }

    setSubmitting(true);
    const res = await placeOrder({
      email: form.email,
      phone: form.phone,
      items: itemsForOrder,
      address: {
        recipient: form.recipient,
        phone: form.phone,
        line1: form.line1,
        line2: form.line2,
        barangay: form.barangay,
        city: form.city,
        province: form.province,
        region: form.region,
        postalCode: form.postalCode,
      },
      shippingMethod,
      paymentMethod,
      couponCode: coupon?.code ?? "",
      note: form.note,
      saveAddress: form.saveAddress,
    });
    setSubmitting(false);

    if (res.ok) {
      await clear();
      toast.success("Order placed");
      router.push(`/order/${res.orderNumber}`);
    } else {
      setError(res.error);
      toast.error(res.error);
    }
  }

  if (hydrated && lines.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong py-20 text-center">
        <ShoppingBag size={22} className="text-ink-faint" />
        <p className="mt-4 font-medium">Your bag is empty</p>
        <Link href="/c/all" className="btn btn-primary mt-5">
          Shop products
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="grid gap-10 lg:grid-cols-[1fr_380px]">
      <div className="space-y-10">
        {!prefill.signedIn && (
          <p className="rounded-sm border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
            Have an account?{" "}
            <Link href="/login?redirectTo=/checkout" className="font-medium text-ink underline">
              Sign in
            </Link>{" "}
            for faster checkout.
          </p>
        )}

        <Section step={1} title="Contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Email" required>
              <input type="email" required value={form.email} onChange={set("email")} className="field" />
            </Field>
            <Field label="Phone" required>
              <input
                type="tel"
                required
                value={form.phone}
                onChange={set("phone")}
                placeholder="+63 9XX XXX XXXX"
                className="field"
              />
            </Field>
          </div>
        </Section>

        <Section step={2} title="Shipping address">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Recipient name" required className="sm:col-span-2">
              <input required value={form.recipient} onChange={set("recipient")} className="field" />
            </Field>
            <Field label="Address line 1" required className="sm:col-span-2">
              <input
                required
                value={form.line1}
                onChange={set("line1")}
                placeholder="House / unit no., street"
                className="field"
              />
            </Field>
            <Field label="Address line 2" className="sm:col-span-2">
              <input
                value={form.line2}
                onChange={set("line2")}
                placeholder="Building, landmark (optional)"
                className="field"
              />
            </Field>
            <Field label="Barangay">
              <input value={form.barangay} onChange={set("barangay")} className="field" />
            </Field>
            <Field label="City / Municipality" required>
              <input required value={form.city} onChange={set("city")} className="field" />
            </Field>
            <Field label="Province" required>
              <input required value={form.province} onChange={set("province")} className="field" />
            </Field>
            <Field label="Postal code" required>
              <input required value={form.postalCode} onChange={set("postalCode")} className="field" />
            </Field>
          </div>
          {prefill.signedIn && (
            <label className="mt-4 flex items-center gap-2.5 text-sm text-ink-soft">
              <input
                type="checkbox"
                checked={form.saveAddress}
                onChange={set("saveAddress")}
                className="accent-ink"
              />
              Save this address to my account
            </label>
          )}
        </Section>

        <Section step={3} title="Delivery method">
          <div className="space-y-3">
            {SHIPPING_METHODS.map((m) => (
              <label
                key={m.id}
                className={cn(
                  "flex cursor-pointer items-center justify-between rounded-md border p-4 transition-colors",
                  shippingMethod === m.id ? "border-ink bg-surface" : "border-line-strong",
                )}
              >
                <span className="flex items-center gap-3">
                  <input
                    type="radio"
                    name="shipping"
                    checked={shippingMethod === m.id}
                    onChange={() => setShippingMethod(m.id as "standard" | "express")}
                    className="accent-ink"
                  />
                  <span>
                    <span className="block text-sm font-medium">{m.label}</span>
                    <span className="block text-xs text-ink-faint">{m.detail}</span>
                  </span>
                </span>
                <span className="text-sm font-medium tabular-nums">{formatPrice(m.fee)}</span>
              </label>
            ))}
          </div>
        </Section>

        <Section step={4} title="Payment">
          <div className="space-y-3">
            {PAYMENT_METHODS.map((m) => (
              <label
                key={m.id}
                className={cn(
                  "flex cursor-pointer items-center gap-3 rounded-md border p-4 transition-colors",
                  paymentMethod === m.id ? "border-ink bg-surface" : "border-line-strong",
                )}
              >
                <input
                  type="radio"
                  name="payment"
                  checked={paymentMethod === m.id}
                  onChange={() => setPaymentMethod(m.id as "COD" | "CARD" | "GCASH")}
                  className="accent-ink"
                />
                <span>
                  <span className="block text-sm font-medium">{m.label}</span>
                  <span className="block text-xs text-ink-faint">{m.detail}</span>
                </span>
              </label>
            ))}
          </div>
          {paymentMethod !== "COD" && (
            <p className="mt-3 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-faint">
              This is a demo store — no real payment is taken. Your order will be marked as paid.
            </p>
          )}
          <Field label="Order note" className="mt-4">
            <textarea
              value={form.note}
              onChange={set("note")}
              rows={2}
              placeholder="Delivery instructions (optional)"
              className="field resize-none"
            />
          </Field>
        </Section>
      </div>

      {/* Summary */}
      <aside className="lg:sticky lg:top-28 lg:h-fit">
        <div className="card-surface p-5">
          <h2 className="text-lg">Your order</h2>
          <ul className="mt-4 max-h-72 space-y-3 overflow-y-auto pr-1">
            {lines.map((l) => {
              const qty = Math.min(l.quantity, l.available);
              return (
              <li key={l.key} className={cn("flex gap-3", l.unavailable && "opacity-50")}>
                <div className="relative h-14 w-12 shrink-0 overflow-hidden rounded-sm bg-surface-sunken">
                  <ProductImage src={l.imageUrl} alt={l.name} />
                  <span className="absolute -right-1.5 -top-1.5 grid h-5 min-w-5 place-items-center rounded-full bg-ink px-1 text-[10px] font-semibold text-paper">
                    {l.unavailable ? 0 : qty}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-1 text-sm font-medium">{l.name}</p>
                  {l.optionSummary && (
                    <p className="text-xs text-ink-faint">{l.optionSummary}</p>
                  )}
                  {l.unavailable && (
                    <p className="text-xs font-medium text-sale">No longer available</p>
                  )}
                </div>
                <span className="text-sm tabular-nums">
                  {l.unavailable ? "—" : formatPrice(l.unitPrice * qty)}
                </span>
              </li>
              );
            })}
          </ul>

          <div className="mt-4 border-t border-line pt-4">
            <CouponField />
          </div>
          <div className="mt-4">
            <OrderSummaryLines shippingMethodId={shippingMethod} />
          </div>

          {error && (
            <p className="mt-4 rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{error}</p>
          )}

          <button
            type="submit"
            disabled={submitting || (hydrated && itemsForOrder.length === 0)}
            className="btn btn-primary mt-5 w-full"
          >
            {submitting ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
            Place order
          </button>
          <p className="mt-3 text-center text-xs text-ink-faint">
            By placing your order you agree to our{" "}
            <Link href="/legal/terms" className="underline">
              Terms
            </Link>
            .
          </p>
        </div>
      </aside>
    </form>
  );
}

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-4 flex items-center gap-3 text-lg">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-ink text-xs font-semibold text-paper">
          {step}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function Field({
  label,
  required,
  className,
  children,
}: {
  label: string;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-sm font-medium">
        {label}
        {required && <span className="text-clay"> *</span>}
      </span>
      {children}
    </label>
  );
}
