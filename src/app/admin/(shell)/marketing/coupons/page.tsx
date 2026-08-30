import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminCoupons } from "@/lib/admin/coupons";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
} from "@/components/admin/ui";
import { CouponsTable } from "@/components/admin/coupons/coupons-table";
import { COUPON_STATE_LABEL } from "@/lib/coupons";

export const metadata: Metadata = { title: "Coupons" };

const STATE_OPTIONS = (
  ["ACTIVE", "SCHEDULED", "DRAFT", "EXPIRED", "DISABLED", "ARCHIVED"] as const
).map((s) => ({ value: s, label: COUPON_STATE_LABEL[s] }));

const SORT_OPTIONS = [
  { value: "oldest", label: "Oldest first" },
  { value: "code", label: "Code A–Z" },
  { value: "most_used", label: "Most used" },
  { value: "ending_soon", label: "Ending soon" },
];

export default async function AdminCouponsPage({ searchParams }: PageProps<"/admin/marketing/coupons">) {
  const admin = await requirePermission("view_coupons");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_coupons");
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const q = str(sp.q);
  const state = str(sp.state);
  const sort = str(sp.sort) as
    | "newest"
    | "oldest"
    | "code"
    | "most_used"
    | "ending_soon"
    | undefined;
  const page = Number(sp.page ?? 1) || 1;

  const { rows, total, pageCount, page: current } = await listAdminCoupons({ q, state, sort, page });
  const searching = Boolean(q || state);

  return (
    <div>
      <PageHeader
        title="Coupons"
        description="Discount codes customers apply at the cart or checkout. The discount is always calculated server-side; every order keeps its own snapshot."
        actions={
          canManage ? (
            <Link href="/admin/marketing/coupons/new" className="btn btn-primary py-2 text-sm">
              <Plus size={14} /> New coupon
            </Link>
          ) : undefined
        }
      />

      <FilterBar>
        <SearchInput placeholder="Code or description…" />
        <FilterSelect label="Status" paramKey="state" options={STATE_OPTIONS} />
        <FilterSelect label="Sort" paramKey="sort" options={SORT_OPTIONS} allLabel="Newest first" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} coupon{total === 1 ? "" : "s"}
        {searching && " match this filter"}
        {!canManage && " · read-only (needs manage_coupons)"}
      </p>

      <CouponsTable rows={rows} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
