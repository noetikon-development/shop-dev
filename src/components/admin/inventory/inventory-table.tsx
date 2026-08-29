"use client";

import { useState } from "react";
import Link from "next/link";
import { SlidersHorizontal } from "lucide-react";
import { DataTable, type Column, StatusBadge } from "@/components/admin/ui";
import { STOCK_STATUS_LABEL, type StockStatus } from "@/lib/inventory-status";
import { formatDate } from "@/lib/utils";
import { AdjustStockModal, type InventoryItem } from "./adjust-stock-modal";

export type Row = InventoryItem & {
  inventoryId: string;
  productId: string;
  status: StockStatus;
  variantStatus: string;
  updatedAt: string;
};

const TONE: Record<StockStatus, "success" | "warning" | "danger"> = {
  IN_STOCK: "success",
  LOW_STOCK: "warning",
  OUT_OF_STOCK: "danger",
};

export function InventoryTable({ rows, canManage }: { rows: Row[]; canManage: boolean }) {
  const [selected, setSelected] = useState<Row | null>(null);

  const columns: Column<Row>[] = [
    {
      key: "product",
      header: "Product / variant",
      cell: (r) => (
        <div className="min-w-0">
          <Link
            href={`/admin/products/${r.productId}`}
            className="font-medium text-ink hover:underline"
          >
            {r.productName}
          </Link>
          <p className="truncate text-xs text-ink-faint">
            {r.optionLabel}
            {r.variantStatus === "ARCHIVED" && " · archived"}
          </p>
        </div>
      ),
    },
    { key: "sku", header: "SKU", cell: (r) => <code className="text-xs">{r.sku}</code> },
    { key: "quantity", header: "On hand", align: "right", cell: (r) => r.quantity },
    { key: "reserved", header: "Reserved", align: "right", cell: (r) => r.reserved },
    {
      key: "available",
      header: "Available",
      align: "right",
      cell: (r) => <span className="font-medium">{r.available}</span>,
    },
    { key: "reorderPoint", header: "Reorder pt", align: "right", cell: (r) => r.reorderPoint },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={TONE[r.status]}>{STOCK_STATUS_LABEL[r.status]}</StatusBadge>
      ),
    },
    { key: "updatedAt", header: "Updated", cell: (r) => formatDate(r.updatedAt) },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            align: "right" as const,
            cell: (r: Row) => (
              <button
                type="button"
                onClick={() => setSelected(r)}
                className="btn btn-ghost p-1.5"
                aria-label={`Adjust stock for ${r.sku}`}
              >
                <SlidersHorizontal size={15} />
              </button>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.inventoryId}
        empty={{ title: "No inventory records match." }}
      />
      <AdjustStockModal
        key={selected?.variantId ?? "none"}
        item={selected}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
