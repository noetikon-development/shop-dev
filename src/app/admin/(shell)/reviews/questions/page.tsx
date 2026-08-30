import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { listAdminQuestions, getQuestionCounts } from "@/lib/admin/questions";
import {
  PageHeader,
  FilterBar,
  SearchInput,
  FilterSelect,
  Pagination,
} from "@/components/admin/ui";
import { QuestionsTable } from "@/components/admin/reviews/questions-table";

export const metadata: Metadata = { title: "Product Q&A" };

const STATUS_OPTIONS = ["PENDING", "APPROVED", "REJECTED", "ARCHIVED"].map((s) => ({
  value: s,
  label: s[0] + s.slice(1).toLowerCase(),
}));
const ANSWERED_OPTIONS = [
  { value: "no", label: "Unanswered" },
  { value: "yes", label: "Answered" },
];
const SORT_OPTIONS = [{ value: "oldest", label: "Oldest first" }];

export default async function AdminQuestionsPage({
  searchParams,
}: PageProps<"/admin/reviews/questions">) {
  const admin = await requirePermission("view_reviews");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_reviews");
  const sp = await searchParams;

  const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const q = str(sp.q);
  const status = str(sp.status);
  const answered = str(sp.answered) as "yes" | "no" | undefined;
  const sort = str(sp.sort) as "newest" | "oldest" | undefined;
  const page = Number(sp.page ?? 1) || 1;

  const [{ rows, total, pageCount, page: current }, counts] = await Promise.all([
    listAdminQuestions({ q, status, answered, sort, page }),
    getQuestionCounts(),
  ]);
  const searching = Boolean(q || status || answered);

  return (
    <div>
      <Link
        href="/admin/reviews"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Reviews
      </Link>

      <PageHeader
        title="Product Q&A"
        description="Moderate customer questions and post official answers. Only APPROVED questions and answers are shown on the storefront."
      />

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        {(["ALL", "PENDING", "APPROVED", "REJECTED", "ARCHIVED"] as const).map((k) => (
          <span key={k} className="rounded-full bg-surface-sunken px-2.5 py-1 text-ink-soft">
            {k === "ALL" ? "Total" : k[0] + k.slice(1).toLowerCase()}: <b>{counts[k]}</b>
          </span>
        ))}
      </div>

      <FilterBar>
        <SearchInput placeholder="Question, product or customer…" />
        <FilterSelect label="Status" paramKey="status" options={STATUS_OPTIONS} />
        <FilterSelect label="Answered" paramKey="answered" options={ANSWERED_OPTIONS} allLabel="Any" />
        <FilterSelect label="Sort" paramKey="sort" options={SORT_OPTIONS} allLabel="Newest first" />
      </FilterBar>

      <p className="mb-3 mt-4 text-xs text-ink-faint">
        {total} question{total === 1 ? "" : "s"}
        {searching && " match this filter"}
        {!canManage && " · read-only (needs manage_reviews)"}
      </p>

      <QuestionsTable rows={rows} canManage={canManage} searching={searching} />

      <div className="mt-4">
        <Pagination page={current} totalPages={pageCount} />
      </div>
    </div>
  );
}
