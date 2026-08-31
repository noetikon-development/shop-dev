import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, RotateCcw } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listCustomerReturns } from "@/lib/returns";
import { returnStatusLabel, returnStatusTone, returnReasonLabel } from "@/lib/returns/status";
import { formatPrice, formatDate, cn } from "@/lib/utils";

export const metadata: Metadata = { title: "Returns" };

const TONE_CLASS: Record<string, string> = {
  success: "bg-sage-50 text-sage",
  info: "bg-clay-50 text-clay",
  warning: "bg-surface-sunken text-ink-soft",
  danger: "bg-clay-50 text-sale",
  neutral: "bg-surface-sunken text-ink-soft",
};

export default async function ReturnsPage() {
  const user = await requireUser("/account/returns");
  const returns = await listCustomerReturns(user.id);

  if (returns.length === 0) {
    return (
      <div className="flex flex-col items-center rounded-lg border border-dashed border-line-strong py-20 text-center">
        <RotateCcw size={24} className="text-ink-faint" />
        <h2 className="mt-4 text-lg">No returns yet</h2>
        <p className="mt-1.5 text-sm text-ink-soft">
          You can start a return from a delivered order.
        </p>
        <Link href="/account/orders" className="btn btn-primary mt-5">
          View orders
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="text-lg">Returns</h2>
      <ul className="space-y-4">
        {returns.map((r) => (
          <li key={r.id} className="card-surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <span className="font-medium">{r.returnNumber}</span>
                <span className="text-ink-faint">Order {r.order.orderNumber}</span>
                <span className="text-ink-faint">{formatDate(r.createdAt)}</span>
              </div>
              <span
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs font-semibold",
                  TONE_CLASS[returnStatusTone(r.status)],
                )}
              >
                {returnStatusLabel(r.status)}
              </span>
            </div>
            <div className="flex items-center gap-4 px-5 py-4 text-sm">
              <p className="min-w-0 flex-1 text-ink-soft">
                {r._count.items} item{r._count.items === 1 ? "" : "s"} · {returnReasonLabel(r.reason)}
                {r.refundAmount != null && (
                  <> · refund {formatPrice(r.refundAmount)}</>
                )}
              </p>
              <Link
                href={`/account/returns/${r.returnNumber}`}
                className="inline-flex shrink-0 items-center gap-1.5 font-medium hover:text-ink-soft"
              >
                Details <ArrowRight size={14} />
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
