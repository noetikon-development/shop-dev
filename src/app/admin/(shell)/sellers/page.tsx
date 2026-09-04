import type { Metadata } from "next";
import Link from "next/link";
import { requirePermission } from "@/lib/admin/rbac";
import { listSellerContent } from "@/lib/admin/seller-content";
import { PageHeader, DataTable, StatusBadge, type Column } from "@/components/admin/ui";
import type { SellerContentRow } from "@/lib/admin/seller-content";
import type { SellerContentStatus } from "@/lib/marketplace/types";

export const metadata: Metadata = { title: "Seller content" };

const STATUS_TONE: Record<SellerContentStatus, "neutral" | "info" | "success"> = {
  DRAFT: "neutral",
  PENDING: "info",
  APPROVED: "success",
};
const STATUS_LABEL: Record<SellerContentStatus, string> = {
  DRAFT: "Draft",
  PENDING: "In review",
  APPROVED: "Approved",
};

const FILTERS: { key: string; label: string; status: SellerContentStatus | "ALL" }[] = [
  { key: "pending", label: "Awaiting review", status: "PENDING" },
  { key: "approved", label: "Approved", status: "APPROVED" },
  { key: "draft", label: "Draft", status: "DRAFT" },
  { key: "all", label: "All", status: "ALL" },
];

export default async function AdminSellersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  await requirePermission("manage_content");
  const sp = await searchParams;
  const active = FILTERS.find((f) => f.key === sp.status) ?? FILTERS[0];
  const rows = await listSellerContent({ status: active.status });

  const columns: Column<SellerContentRow>[] = [
    {
      key: "displayName",
      header: "Seller",
      cell: (r) => (
        <Link href={`/admin/sellers/${r.sellerId}`} className="font-medium text-ink hover:underline">
          {r.displayName}
          <span className="ml-2 text-xs text-ink-faint">/{r.slug}</span>
        </Link>
      ),
    },
    {
      key: "contentStatus",
      header: "Profile",
      cell: (r) => (
        <StatusBadge tone={STATUS_TONE[r.contentStatus]}>{STATUS_LABEL[r.contentStatus]}</StatusBadge>
      ),
    },
    {
      key: "submittedAt",
      header: "Submitted",
      cell: (r) => (r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : "—"),
    },
    {
      key: "reviewedAt",
      header: "Last reviewed",
      cell: (r) => (r.reviewedAt ? new Date(r.reviewedAt).toLocaleDateString() : "—"),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Seller content"
        description="Review third-party seller store-profile submissions. Full seller management arrives in a later phase."
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "pending" ? "/admin/sellers" : `/admin/sellers?status=${f.key}`}
            className={`rounded-sm border px-3 py-1 text-sm ${
              f.key === active.key
                ? "border-ink bg-ink text-paper"
                : "border-line text-ink-soft hover:bg-surface-sunken"
            }`}
          >
            {f.label}
          </Link>
        ))}
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.sellerId}
        empty={{ title: "Nothing here", description: `No sellers with status "${active.label}".` }}
      />
    </div>
  );
}
