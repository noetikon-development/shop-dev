import type { Metadata } from "next";
import Link from "next/link";
import { MessagesSquare } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import {
  listAdminReviews,
  getReviewCounts,
  type AdminReviewSort,
} from "@/lib/admin/reviews";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
} from "@/components/admin/ui";
import { ReviewsTable } from "@/components/admin/reviews/reviews-table";

export const metadata: Metadata = { title: "Reviews" };

const STATUS_OPTIONS = ["PENDING", "APPROVED", "REJECTED", "ARCHIVED"].map((s) => ({
  value: s,
  label: s[0] + s.slice(1).toLowerCase(),
}));
const RATING_OPTIONS = [5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: `${n} star${n > 1 ? "s" : ""}` }));
const VERIFIED_OPTIONS = [
  { value: "yes", label: "Verified only" },
  { value: "no", label: "Unverified only" },
];
const SORT_OPTIONS = [
  { value: "oldest", label: "Oldest first" },
  { value: "rating_high", label: "Highest rating" },
  { value: "rating_low", label: "Lowest rating" },
];

export default async function AdminReviewsPage({ searchParams }: PageProps<"/admin/reviews">) {
  const admin = await requirePermission("view_reviews");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_reviews");
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const q = str(sp.q);
  const status = str(sp.status);
  const rating = str(sp.rating) ? Number(str(sp.rating)) : undefined;
  const verified = str(sp.verified) as "yes" | "no" | undefined;
  const sort = str(sp.sort) as AdminReviewSort | undefined;
  const page = Number(sp.page ?? 1) || 1;

  const [{ rows, total, pageCount, page: current }, counts] = await Promise.all([
    listAdminReviews({ q, status, rating, verified, sort, page }),
    getReviewCounts(),
  ]);
  const searching = Boolean(q || status || rating || verified);

  return (
    <div>
      <PageHeader
        title="Reviews"
        description="Moderate customer reviews. Only APPROVED reviews are shown on the storefront and counted in a product's rating."
        actions={
          <Link href="/admin/reviews/questions" className="btn btn-outline py-2 text-sm">
            <MessagesSquare size={14} /> Q&amp;A
          </Link>
        }
      />

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {(["ALL", "PENDING", "APPROVED", "REJECTED", "ARCHIVED"] as const).map((k) => (
          <span key={k} className="rounded-full bg-surface-sunken px-2.5 py-1 text-ink-soft">
            {k === "ALL" ? "Total" : k[0] + k.slice(1).toLowerCase()}: <b>{counts[k]}</b>
          </span>
        ))}
      </div>

      <FilterBar>
        <SearchInput placeholder="Title, text, product or customer…" />
        <FilterSelect label="Status" paramKey="status" options={STATUS_OPTIONS} />
        <FilterSelect label="Rating" paramKey="rating" options={RATING_OPTIONS} />
        <FilterSelect label="Verified" paramKey="verified" options={VERIFIED_OPTIONS} allLabel="Any" />
        <FilterSelect label="Sort" paramKey="sort" options={SORT_OPTIONS} allLabel="Newest first" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} review{total === 1 ? "" : "s"}
        {searching && " match this filter"}
        {!canManage && " · read-only (needs manage_reviews)"}
      </p>

      <ReviewsTable rows={rows} canManage={canManage} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
