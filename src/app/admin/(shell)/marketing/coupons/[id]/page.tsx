import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { getCurrentAdmin, requirePermission } from "@/lib/admin/rbac";
import { getAdminCoupon } from "@/lib/admin/coupons";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { CouponDetailActions } from "@/components/admin/coupons/coupon-detail-actions";
import { COUPON_STATE_LABEL, couponStateTone } from "@/lib/coupons";
import { orderStatusLabel } from "@/lib/orders/status";
import { formatPrice, formatDate } from "@/lib/utils";

export async function generateMetadata({
  params,
}: PageProps<"/admin/marketing/coupons/[id]">): Promise<Metadata> {
  const admin = await getCurrentAdmin();
  if (!admin || !(admin.isSuperAdmin || admin.permissions.has("view_coupons"))) {
    return { title: "Coupon" };
  }
  const { id } = await params;
  const c = await getAdminCoupon(id);
  return { title: c ? `Coupon ${c.code}` : "Coupon" };
}

function dt(iso: string | null) {
  return iso ? formatDate(iso, { hour: "numeric", minute: "2-digit" }) : "—";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-ink-faint">{label}</dt>
      <dd className="mt-0.5 text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function CouponDetailPage({
  params,
}: PageProps<"/admin/marketing/coupons/[id]">) {
  const admin = await requirePermission("view_coupons");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_coupons");
  const { id } = await params;

  const coupon = await getAdminCoupon(id);
  if (!coupon) notFound();

  const discount =
    coupon.type === "PERCENT"
      ? `${coupon.value}%${coupon.maxDiscount ? ` (max ${formatPrice(coupon.maxDiscount)})` : ""}`
      : coupon.type === "FIXED"
        ? formatPrice(coupon.value)
        : coupon.type;

  return (
    <div>
      <Link
        href="/admin/marketing/coupons"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All coupons
      </Link>

      <PageHeader
        title={coupon.code}
        description={coupon.description ?? undefined}
        actions={
          <CouponDetailActions
            id={coupon.id}
            active={coupon.active}
            archived={Boolean(coupon.archivedAt)}
            canManage={canManage}
          />
        }
      >
        <StatusBadge tone={couponStateTone(coupon.state)}>
          {COUPON_STATE_LABEL[coupon.state]}
        </StatusBadge>
      </PageHeader>

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card>
            <h2 className="text-sm font-semibold text-ink">Discount rules</h2>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-3">
              <Field label="Type">{coupon.type === "PERCENT" ? "Percentage" : "Fixed amount"}</Field>
              <Field label="Discount">{discount}</Field>
              <Field label="Minimum order">
                {coupon.minSubtotal > 0 ? formatPrice(coupon.minSubtotal) : "None"}
              </Field>
              <Field label="Starts">{dt(coupon.startsAt)}</Field>
              <Field label="Expires">{dt(coupon.expiresAt)}</Field>
              <Field label="Total limit">{coupon.usageLimit ?? "Unlimited"}</Field>
              <Field label="Per customer">{coupon.perCustomerLimit ?? "Unlimited"}</Field>
              <Field label="Created">{dt(coupon.createdAt)}</Field>
              <Field label="Updated">{dt(coupon.updatedAt)}</Field>
            </dl>
          </Card>

          <Card padded={false}>
            <h2 className="px-5 pt-5 text-sm font-semibold text-ink">
              Recent redemptions ({coupon.uses} active)
            </h2>
            {coupon.redemptions.length === 0 ? (
              <p className="px-5 pb-5 pt-2 text-sm text-ink-faint">No redemptions yet.</p>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[32rem] text-sm">
                  <thead>
                    <tr className="border-y border-line bg-surface-sunken/60 text-left text-xs uppercase tracking-wide text-ink-faint">
                      <th className="px-5 py-2.5 font-semibold">Order</th>
                      <th className="px-4 py-2.5 font-semibold">Customer</th>
                      <th className="px-4 py-2.5 font-semibold">Order status</th>
                      <th className="px-4 py-2.5 text-right font-semibold">Discount</th>
                      <th className="px-5 py-2.5 font-semibold">Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coupon.redemptions.map((r) => (
                      <tr key={r.id} className="border-b border-line/60 last:border-0">
                        <td className="px-5 py-3">
                          <span className="font-mono text-xs">{r.orderNumber}</span>
                        </td>
                        <td className="px-4 py-3 text-ink-soft">{r.customer}</td>
                        <td className="px-4 py-3">
                          <span
                            className={
                              r.orderStatus === "CANCELLED" ? "text-ink-faint line-through" : "text-ink-soft"
                            }
                          >
                            {orderStatusLabel(r.orderStatus)}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums">−{formatPrice(r.amount)}</td>
                        <td className="px-5 py-3 text-xs text-ink-faint">{dt(r.createdAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="px-5 pb-4 pt-3 text-xs text-ink-faint">
                  Cancelled orders don’t count toward the usage limits.
                </p>
              </div>
            )}
          </Card>
        </div>

        <aside className="space-y-6">
          <Card>
            <h2 className="text-sm font-semibold text-ink">Usage</h2>
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-soft">Active redemptions</dt>
                <dd className="tabular-nums">
                  {coupon.uses}
                  {coupon.usageLimit != null ? ` / ${coupon.usageLimit}` : ""}
                </dd>
              </div>
              {coupon.usageLimit != null && (
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className="h-full rounded-full bg-clay"
                    style={{
                      width: `${Math.min(100, Math.round((coupon.uses / coupon.usageLimit) * 100))}%`,
                    }}
                  />
                </div>
              )}
            </dl>
          </Card>
        </aside>
      </div>
    </div>
  );
}
