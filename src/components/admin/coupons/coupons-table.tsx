"use client";

import Link from "next/link";
import { TicketPercent } from "lucide-react";
import { DataTable, type Column, StatusBadge } from "@/components/admin/ui";
import { formatPrice, formatDate } from "@/lib/utils";
import { COUPON_STATE_LABEL, couponStateTone, type CouponState } from "@/lib/coupons";
import type { AdminCouponRow } from "@/lib/admin/coupons";

function discountLabel(r: AdminCouponRow): string {
  if (r.type === "PERCENT") {
    return `${r.value}% off${r.maxDiscount ? ` (max ${formatPrice(r.maxDiscount)})` : ""}`;
  }
  if (r.type === "FIXED") return `${formatPrice(r.value)} off`;
  return r.type;
}

function validityLabel(r: AdminCouponRow): string {
  const fmt = (iso: string) => formatDate(iso, { month: "short", day: "numeric" });
  if (r.startsAt && r.expiresAt) return `${fmt(r.startsAt)} – ${fmt(r.expiresAt)}`;
  if (r.expiresAt) return `Until ${fmt(r.expiresAt)}`;
  if (r.startsAt) return `From ${fmt(r.startsAt)}`;
  return "No date limit";
}

export function CouponsTable({ rows, searching }: { rows: AdminCouponRow[]; searching: boolean }) {
  const columns: Column<AdminCouponRow>[] = [
    {
      key: "code",
      header: "Code",
      cell: (r) => (
        <div className="min-w-0">
          <Link
            href={`/admin/marketing/coupons/${r.id}`}
            className="font-mono font-medium text-ink hover:underline"
          >
            {r.code}
          </Link>
          {r.description && <p className="truncate text-xs text-ink-faint">{r.description}</p>}
        </div>
      ),
    },
    {
      key: "discount",
      header: "Discount",
      cell: (r) => (
        <div className="min-w-0">
          <p className="text-ink">{discountLabel(r)}</p>
          {r.minSubtotal > 0 && (
            <p className="text-xs text-ink-faint">Min {formatPrice(r.minSubtotal)}</p>
          )}
        </div>
      ),
    },
    {
      key: "validity",
      header: "Validity",
      cell: (r) => <span className="whitespace-nowrap text-ink-soft">{validityLabel(r)}</span>,
    },
    {
      key: "usage",
      header: "Uses",
      align: "right",
      cell: (r) => (
        <span className="whitespace-nowrap tabular-nums text-ink-soft">
          {r.uses}
          {r.usageLimit != null ? ` / ${r.usageLimit}` : ""}
          {r.perCustomerLimit != null && (
            <span className="ml-1 text-xs text-ink-faint">({r.perCustomerLimit}/cust)</span>
          )}
        </span>
      ),
    },
    {
      key: "state",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={couponStateTone(r.state as CouponState)}>
          {COUPON_STATE_LABEL[r.state as CouponState]}
        </StatusBadge>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <TicketPercent size={18} />,
        title: searching ? "No coupons match your search." : "No coupons yet.",
        description: searching
          ? "Try a different code, description or status."
          : "Create a discount code to get started.",
      }}
    />
  );
}
