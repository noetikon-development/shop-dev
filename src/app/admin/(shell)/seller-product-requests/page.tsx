import type { Metadata } from "next";
import Link from "next/link";
import { requireAnyPermission } from "@/lib/admin/rbac";
import {
  listAdminProductRequests,
  adminRequestStatusCounts,
  type AdminRequestRow,
} from "@/lib/admin/seller-product-requests/repository";
import { PageHeader, DataTable, StatusBadge, type Column } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Seller product requests" };

const TONE = { DRAFT: "neutral", PENDING: "info", APPROVED: "success", REJECTED: "danger" } as const;
const LABEL = { DRAFT: "Draft", PENDING: "In review", APPROVED: "Approved", REJECTED: "Rejected" } as const;

const FILTERS: { key: string; label: string; status?: string }[] = [
  { key: "pending", label: "In review", status: "PENDING" },
  { key: "approved", label: "Approved", status: "APPROVED" },
  { key: "rejected", label: "Rejected", status: "REJECTED" },
  { key: "draft", label: "Draft", status: "DRAFT" },
  { key: "all", label: "All" },
];

export default async function AdminSellerProductRequestsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  await requireAnyPermission(["manage_content", "create_products"]);
  const sp = await searchParams;
  const active = FILTERS.find((f) => f.key === sp.status) ?? FILTERS[0];
  const [rows, counts] = await Promise.all([
    listAdminProductRequests({ status: active.status ?? "ALL", q: sp.q }),
    adminRequestStatusCounts(),
  ]);

  const columns: Column<AdminRequestRow>[] = [
    {
      key: "productName",
      header: "Proposed product",
      cell: (r) => (
        <Link href={`/admin/seller-product-requests/${r.id}`} className="font-medium text-ink hover:underline">
          {r.productName}
        </Link>
      ),
    },
    {
      key: "sellerName",
      header: "Seller",
      cell: (r) => (
        <Link href={`/admin/sellers/${r.sellerId}`} className="text-ink-soft hover:underline">
          {r.sellerName}
        </Link>
      ),
    },
    { key: "categoryName", header: "Category", cell: (r) => r.categoryName ?? "—" },
    { key: "variantCount", header: "Variants", align: "right", cell: (r) => r.variantCount },
    { key: "imageCount", header: "Images", align: "right", cell: (r) => r.imageCount },
    {
      key: "submittedAt",
      header: "Submitted",
      cell: (r) => (r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : "—"),
    },
    {
      key: "status",
      header: "Status",
      cell: (r) => (
        <StatusBadge tone={TONE[r.status as keyof typeof TONE] ?? "neutral"}>
          {LABEL[r.status as keyof typeof LABEL] ?? r.status}
        </StatusBadge>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Seller product requests"
        description="Products third-party sellers have asked Axiaro to add. Approving a request creates or links a canonical product — it does not put any seller offer on the storefront."
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "pending" ? "/admin/seller-product-requests" : `/admin/seller-product-requests?status=${f.key}`}
            className={`rounded-sm border px-3 py-1 ${
              f.key === active.key ? "border-ink bg-ink text-paper" : "border-line text-ink-soft hover:bg-surface-sunken"
            }`}
          >
            {f.label}
            {f.status && <span className="ml-1.5 text-xs opacity-70">{counts[f.status] ?? 0}</span>}
          </Link>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: "Nothing here", description: `No requests with status “${active.label}”.` }}
      />
    </div>
  );
}
