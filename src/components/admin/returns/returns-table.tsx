"use client";

import Link from "next/link";
import { RotateCcw } from "lucide-react";
import { DataTable, type Column, StatusBadge } from "@/components/admin/ui";
import { formatPrice, formatDate } from "@/lib/utils";
import { returnStatusLabel, returnStatusTone, returnReasonLabel } from "@/lib/returns/status";
import type { AdminReturnRow } from "@/lib/admin/returns";

export function ReturnsTable({ rows, searching }: { rows: AdminReturnRow[]; searching: boolean }) {
  const columns: Column<AdminReturnRow>[] = [
    {
      key: "returnNumber",
      header: "Return",
      cell: (r) => (
        <div className="min-w-0">
          <Link href={`/admin/returns/${r.id}`} className="font-medium text-ink hover:underline">
            {r.returnNumber}
          </Link>
          {r.adminAssisted && <p className="text-xs text-ink-faint">Assisted</p>}
        </div>
      ),
    },
    {
      key: "order",
      header: "Order",
      cell: (r) => (
        <Link href={`/admin/orders/${r.orderId}`} className="font-mono text-xs text-ink-soft hover:underline">
          {r.orderNumber}
        </Link>
      ),
    },
    {
      key: "customer",
      header: "Customer",
      cell: (r) => (
        <div className="min-w-0">
          <p className="truncate text-ink">{r.customerName}</p>
          <p className="truncate text-xs text-ink-faint">{r.customerEmail}</p>
        </div>
      ),
    },
    {
      key: "items",
      header: "Items",
      cell: (r) => (
        <span className="whitespace-nowrap text-ink-soft">
          {r.unitCount} unit{r.unitCount === 1 ? "" : "s"}
        </span>
      ),
    },
    {
      key: "reason",
      header: "Reason",
      cell: (r) => <span className="text-ink-soft">{returnReasonLabel(r.reason)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={returnStatusTone(r.status)}>{returnStatusLabel(r.status)}</StatusBadge>
      ),
    },
    {
      key: "refund",
      header: "Refund",
      align: "right",
      cell: (r) =>
        r.refundAmount != null ? (
          <span className="whitespace-nowrap tabular-nums">{formatPrice(r.refundAmount)}</span>
        ) : (
          <span className="text-ink-faint">—</span>
        ),
    },
    {
      key: "createdAt",
      header: "Requested",
      cell: (r) => (
        <span className="whitespace-nowrap text-xs text-ink-faint">{formatDate(r.createdAt)}</span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <RotateCcw size={18} />,
        title: searching ? "No returns match your filter." : "No return requests yet.",
        description: searching
          ? "Try a different return number, order, status or date range."
          : "Return requests raised by customers will appear here.",
      }}
    />
  );
}
