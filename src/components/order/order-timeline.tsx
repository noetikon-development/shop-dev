import { Check } from "lucide-react";
import { ORDER_STATUS_FLOW, ORDER_STATUS_META } from "@/lib/constants";
import { processingRungOverride } from "@/lib/orders/status";
import { formatDate, cn } from "@/lib/utils";

type SellerOrderInfo = { sellerType: string; status: string; sellerName: string };

type Event = {
  status: string;
  title: string;
  detail?: string | null;
  location?: string | null;
  createdAt: Date | string;
};

// Store-pickup orders skip the courier stages — PROCESSING goes straight to
// DELIVERED (collected). Same status vocabulary, shorter ladder.
const PICKUP_STATUS_FLOW = ["PENDING", "PAID", "PROCESSING", "DELIVERED"] as const;

export function OrderTimeline({
  status,
  events,
  pickup = false,
  sellerOrders = [],
  paymentStatus,
}: {
  status: string;
  events: Event[];
  pickup?: boolean;
  /** 9F-16B: reword the PROCESSING rung while a THIRD_PARTY SellerOrder is still
   *  awaiting the seller's "Accept order". Empty on the public tracking page. */
  sellerOrders?: SellerOrderInfo[];
  /** 9F-21: the "Payment confirmed" rung is shown ONLY for an order that was
   *  actually paid. A COD order (paid on delivery) never had a payment moment,
   *  so the rung is dropped rather than rendered as a completed step. */
  paymentStatus?: string;
}) {
  if (status === "CANCELLED") {
    return (
      <div className="rounded-md border border-sale/30 bg-clay-50 px-4 py-3 text-sm text-sale">
        This order was cancelled.
      </div>
    );
  }

  if (status === "PENDING_PAYMENT") {
    return (
      <div className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-ink-soft">
        <p className="font-medium text-ink">Order placed</p>
        <p className="mt-1">
          We&apos;ve received your order. Payment is arranged on delivery — our team will confirm
          the details with you and start preparing your items.
        </p>
      </div>
    );
  }

  // 9F-21: the "PAID" rung belongs only to an order that was actually paid.
  // COD orders (1P and 3P) advance to PROCESSING and beyond with no payment
  // collected, so the rung is filtered out — never shown as a completed step.
  const paid = paymentStatus === "PAID" || status === "PAID";
  const baseFlow: readonly string[] = pickup ? PICKUP_STATUS_FLOW : ORDER_STATUS_FLOW;
  const flow: readonly string[] = paid ? baseFlow : baseFlow.filter((s) => s !== "PAID");
  const currentIndex = flow.indexOf(status);
  const eventByStatus = new Map(events.map((e) => [e.status, e]));
  // 9F-16B: only the PROCESSING rung, only while a THIRD_PARTY SellerOrder is
  // still PENDING_PAYMENT (seller hasn't accepted). null otherwise → default copy.
  const procOverride = processingRungOverride(status, sellerOrders);

  return (
    <ol className="relative space-y-6">
      {flow.map((s, i) => {
        const meta = ORDER_STATUS_META[s];
        const done = i <= currentIndex;
        const active = i === currentIndex;
        const ev = eventByStatus.get(s);
        const override = s === "PROCESSING" ? procOverride : null;
        return (
          <li key={s} className="relative flex gap-4 pl-1">
            {i < flow.length - 1 && (
              <span
                className={cn(
                  "absolute left-[13px] top-6 h-[calc(100%+0.5rem)] w-px",
                  i < currentIndex ? "bg-ink" : "bg-line-strong",
                )}
              />
            )}
            <span
              className={cn(
                "relative z-10 mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full border-2 transition-colors",
                done ? "border-ink bg-ink text-paper" : "border-line-strong bg-paper text-transparent",
                active && "ring-4 ring-ink/10",
              )}
            >
              <Check size={12} strokeWidth={3} />
            </span>
            <div className="pb-1">
              <p className={cn("text-sm font-medium", done ? "text-ink" : "text-ink-faint")}>
                {override?.title ?? ev?.title ?? meta.label}
              </p>
              <p className="text-xs text-ink-faint">
                {override
                  ? override.description
                  : ev
                    ? [ev.location, formatDate(ev.createdAt, { hour: "numeric", minute: "2-digit" })]
                        .filter(Boolean)
                        .join(" · ")
                    : meta.description}
              </p>
              {!override && ev?.detail && <p className="mt-1 text-xs text-ink-soft">{ev.detail}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
