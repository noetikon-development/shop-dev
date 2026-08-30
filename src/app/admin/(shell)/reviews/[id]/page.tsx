import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminReview } from "@/lib/admin/reviews";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { Stars } from "@/components/ui/primitives";
import { ReviewDetailActions } from "@/components/admin/reviews/review-detail-actions";
import { formatDate } from "@/lib/utils";
import type { ReviewStatus } from "@/lib/reviews";

const STATUS_TONE: Record<ReviewStatus, "neutral" | "success" | "warning" | "danger"> = {
  PENDING: "warning",
  APPROVED: "success",
  REJECTED: "danger",
  ARCHIVED: "neutral",
};

export async function generateMetadata({
  params,
}: PageProps<"/admin/reviews/[id]">): Promise<Metadata> {
  const admin = await getCurrentAdmin();
  if (!admin || !(admin.isSuperAdmin || admin.permissions.has("view_reviews"))) {
    return { title: "Review" };
  }
  const { id } = await params;
  const r = await getAdminReview(id);
  return { title: r ? `Review · ${r.product.name}` : "Review" };
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function AdminReviewDetailPage({ params }: PageProps<"/admin/reviews/[id]">) {
  const admin = await requirePermission("view_reviews");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_reviews");
  const { id } = await params;
  if (id === "questions") notFound();

  const review = await getAdminReview(id);
  if (!review) notFound();

  return (
    <div>
      <Link
        href="/admin/reviews"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All reviews
      </Link>

      <PageHeader
        title={review.title || "Review"}
        description={`For ${review.product.name}`}
        actions={<ReviewDetailActions id={review.id} status={review.status} canManage={canManage} />}
      >
        <div className="flex items-center gap-3">
          <Stars value={review.rating} showNumber={false} />
          <StatusBadge tone={STATUS_TONE[review.status]}>{review.status}</StatusBadge>
          {review.verified && <StatusBadge tone="success">Verified purchase</StatusBadge>}
        </div>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <h2 className="text-sm font-semibold text-ink">Review content</h2>
          <p className="mt-3 whitespace-pre-line text-sm leading-relaxed text-ink-soft">
            {review.body}
          </p>
        </Card>

        <aside className="space-y-6">
          <Card>
            <h2 className="text-sm font-semibold text-ink">Details</h2>
            <dl className="mt-3 space-y-3">
              <Field label="Customer">
                {review.customer.name ?? "—"}
                <span className="block text-xs text-ink-faint">{review.customer.email}</span>
              </Field>
              <Field label="Product">
                <Link href={`/p/${review.product.slug}`} target="_blank" className="hover:underline">
                  {review.product.name}
                </Link>
                <span className="block text-xs text-ink-faint">status: {review.product.status}</span>
              </Field>
              <Field label="Establishing order">
                {review.order ? (
                  <>
                    <span className="font-mono text-xs">{review.order.orderNumber}</span>
                    <span className="block text-xs text-ink-faint">
                      {review.order.status} · {formatDate(review.order.placedAt)}
                    </span>
                  </>
                ) : (
                  "—"
                )}
              </Field>
              <Field label="Submitted">{formatDate(review.createdAt, { hour: "numeric", minute: "2-digit" })}</Field>
              <Field label="Last updated">{formatDate(review.updatedAt, { hour: "numeric", minute: "2-digit" })}</Field>
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
