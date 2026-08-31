"use client";

import Link from "next/link";
import { CreditCard } from "lucide-react";
import { DataTable, type Column, StatusBadge } from "@/components/admin/ui";
import { formatPrice, formatDate } from "@/lib/utils";
import { paymentStatusLabel, paymentStatusTone } from "@/lib/payments/status";
import type { AdminPaymentRow } from "@/lib/admin/payments";

export function PaymentsTable({ rows, searching }: { rows: AdminPaymentRow[]; searching: boolean }) {
  const columns: Column<AdminPaymentRow>[] = [
    {
      key: "order",
      header: "Order",
      cell: (r) => (
        <Link href={`/admin/orders/${r.orderId}`} className="font-medium text-ink hover:underline">
          {r.orderNumber}
        </Link>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (r) => <span className="truncate text-ink-soft">{r.customerEmail}</span>,
    },
    {
      key: "providerId",
      header: "Provider ref",
      cell: (r) => <code className="text-xs text-ink-faint">{r.providerId}</code>,
    },
    {
      key: "method",
      header: "Method",
      cell: (r) => <span className="text-ink-soft">{r.method ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={paymentStatusTone(r.status)}>{paymentStatusLabel(r.status)}</StatusBadge>
      ),
    },
    {
      key: "amount",
      header: "Amount",
      align: "right",
      cell: (r) => (
        <div className="whitespace-nowrap text-right tabular-nums">
          {formatPrice(r.amount)}
          {r.refundedAmount > 0 && (
            <p className="text-xs text-ink-faint">−{formatPrice(r.refundedAmount)} refunded</p>
          )}
        </div>
      ),
    },
    {
      key: "paidAt",
      header: "Paid",
      cell: (r) => (
        <span className="whitespace-nowrap text-xs text-ink-faint">
          {r.paidAt ? formatDate(r.paidAt) : "—"}
        </span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <CreditCard size={18} />,
        title: searching ? "No payments match your filter." : "No payment records yet.",
        description: searching
          ? "Try a different reference, order, status or date range."
          : "PayMongo payment records will appear here once online payment is enabled.",
      }}
    />
  );
}
