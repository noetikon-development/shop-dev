"use client";

import Link from "next/link";
import { Package } from "lucide-react";
import { DataTable, type Column, StatusBadge } from "@/components/admin/ui";
import { formatPrice, formatDate } from "@/lib/utils";
import {
  orderStatusLabel,
  orderStatusTone,
  paymentStatusTone,
  PAYMENT_STATUS_LABEL,
} from "@/lib/orders/status";
import type { AdminOrderRow } from "@/lib/admin/orders";

export function OrdersTable({ rows, searching }: { rows: AdminOrderRow[]; searching: boolean }) {
  const columns: Column<AdminOrderRow>[] = [
    {
      key: "orderNumber",
      header: "Order",
      cell: (r) => (
        <Link href={`/admin/orders/${r.id}`} className="font-medium text-ink hover:underline">
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
      key: "placedAt",
      header: "Date",
      cell: (r) => <span className="whitespace-nowrap text-ink-soft">{formatDate(r.placedAt)}</span>,
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={orderStatusTone(r.status)}>{orderStatusLabel(r.status)}</StatusBadge>
      ),
    },
    {
      key: "paymentStatus",
      header: "Payment",
      cell: (r) => (
        <StatusBadge tone={paymentStatusTone(r.paymentStatus)}>
          {PAYMENT_STATUS_LABEL[r.paymentStatus] ?? r.paymentStatus}
        </StatusBadge>
      ),
    },
    {
      key: "shipping",
      header: "Shipping",
      cell: (r) => <span className="text-ink-soft">{r.shippingMethodLabel}</span>,
    },
    {
      key: "grandTotal",
      header: "Total",
      align: "right",
      cell: (r) => (
        <span className="whitespace-nowrap font-medium tabular-nums">
          {formatPrice(r.grandTotal)}
        </span>
      ),
    },
    {
      key: "updatedAt",
      header: "Updated",
      cell: (r) => (
        <span className="whitespace-nowrap text-xs text-ink-faint">{formatDate(r.updatedAt)}</span>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      getRowKey={(r) => r.id}
      empty={{
        icon: <Package size={18} />,
        title: searching ? "No orders match your search." : "No orders found.",
        description: searching
          ? "Try a different order number, customer, status or date range."
          : "Orders placed through checkout will appear here.",
      }}
    />
  );
}
