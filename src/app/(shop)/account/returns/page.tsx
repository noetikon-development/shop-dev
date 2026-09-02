import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, RotateCcw } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { listCustomerReturns } from "@/lib/returns";
import { returnStatusLabel, returnStatusTone, returnReasonLabel } from "@/lib/returns/status";
import { formatPrice, formatDate } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export const metadata: Metadata = { title: "Returns" };

export default async function ReturnsPage() {
  const user = await requireUser("/account/returns");
  const returns = await listCustomerReturns(user.id);

  if (returns.length === 0) {
    return (
      <EmptyState
        icon={<RotateCcw size={24} />}
        title="No returns yet"
        message="You can start a return from a delivered order."
        action={
          <Link href="/account/orders" className={buttonClasses()}>
            View orders
          </Link>
        }
      />
    );
  }

  return (
    <div className="space-y-5">
      <h2 className="text-subtitle">Returns</h2>
      <ul className="space-y-4">
        {returns.map((r) => (
          <li key={r.id} className="card-surface overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                <span className="font-medium">{r.returnNumber}</span>
                <span className="text-ink-faint">Order {r.order.orderNumber}</span>
                <span className="text-ink-faint">{formatDate(r.createdAt)}</span>
              </div>
              <Badge tone={returnStatusTone(r.status)}>{returnStatusLabel(r.status)}</Badge>
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
