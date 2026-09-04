import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import { listAdminSellers, sellerStatusCounts, type AdminSellerRow } from "@/lib/admin/sellers/repository";
import { countPendingSellerContent } from "@/lib/admin/seller-content";
import { sellerStatusLabel, sellerStatusTone } from "@/lib/admin/sellers/lifecycle";
import { PageHeader, DataTable, StatusBadge, type Column } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Sellers" };

const CONTENT_TONE = { DRAFT: "neutral", PENDING: "info", APPROVED: "success" } as const;
const CONTENT_LABEL = { DRAFT: "Draft", PENDING: "In review", APPROVED: "Approved" } as const;

const FILTERS: { key: string; label: string; where: { status?: string } }[] = [
  { key: "all", label: "All", where: {} },
  { key: "pending", label: "Pending", where: { status: "PENDING" } },
  { key: "approved", label: "Approved", where: { status: "APPROVED" } },
  { key: "suspended", label: "Suspended", where: { status: "SUSPENDED" } },
  { key: "closed", label: "Closed", where: { status: "CLOSED" } },
];

export default async function AdminSellersPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; q?: string }>;
}) {
  const admin = await requireAnyPermission(["manage_settings", "manage_content"]);
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_settings");

  const sp = await searchParams;
  const active = FILTERS.find((f) => f.key === sp.status) ?? FILTERS[0];
  const [rows, counts, pendingContent] = await Promise.all([
    listAdminSellers({ ...active.where, q: sp.q }),
    sellerStatusCounts(),
    countPendingSellerContent(),
  ]);

  const columns: Column<AdminSellerRow>[] = [
    {
      key: "displayName",
      header: "Seller",
      cell: (r) => (
        <Link href={`/admin/sellers/${r.id}`} className="font-medium text-ink hover:underline">
          {r.displayName}
          <span className="ml-2 text-xs text-ink-faint">/{r.slug}</span>
        </Link>
      ),
    },
    { key: "type", header: "Type", cell: (r) => (r.type === "FIRST_PARTY" ? "1P" : "3P") },
    {
      key: "status",
      header: "Status",
      cell: (r) => <StatusBadge tone={sellerStatusTone(r.status)}>{sellerStatusLabel(r.status)}</StatusBadge>,
    },
    {
      key: "contentStatus",
      header: "Profile",
      cell: (r) => (
        <StatusBadge tone={CONTENT_TONE[r.contentStatus]}>{CONTENT_LABEL[r.contentStatus]}</StatusBadge>
      ),
    },
    // Commission is business configuration — shown only to manage_settings holders.
    ...(canManage
      ? [{ key: "commissionRate", header: "Commission", cell: (r: AdminSellerRow) => `${(r.commissionRate / 100).toFixed(2)}%` }]
      : []),
    { key: "sellerUserCount", header: "Members", align: "right", cell: (r) => r.sellerUserCount },
    { key: "offerCount", header: "Offers", align: "right", cell: (r) => r.offerCount },
    { key: "createdAt", header: "Created", cell: (r) => new Date(r.createdAt).toLocaleDateString() },
  ];

  return (
    <div>
      <PageHeader
        title="Sellers"
        description="Third-party marketplace sellers. Customer-visible multi-seller checkout is off — approving a seller does not put its offers on the storefront."
        actions={
          canManage ? (
            <Link href="/admin/sellers/new" className="btn btn-primary py-2 text-sm">
              <Plus size={14} /> New seller
            </Link>
          ) : (
            <StatusBadge tone="neutral">Read-only</StatusBadge>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={f.key === "all" ? "/admin/sellers" : `/admin/sellers?status=${f.key}`}
            className={`rounded-sm border px-3 py-1 ${
              f.key === active.key
                ? "border-ink bg-ink text-paper"
                : "border-line text-ink-soft hover:bg-surface-sunken"
            }`}
          >
            {f.label}
            {f.where.status && (
              <span className="ml-1.5 text-xs opacity-70">{counts[f.where.status] ?? 0}</span>
            )}
          </Link>
        ))}
        {pendingContent > 0 && (
          <span className="ml-auto text-xs text-ink-faint">
            {pendingContent} profile{pendingContent === 1 ? "" : "s"} awaiting content review
          </span>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        getRowKey={(r) => r.id}
        empty={{ title: "No sellers", description: `No sellers with status “${active.label}”.` }}
      />
    </div>
  );
}
