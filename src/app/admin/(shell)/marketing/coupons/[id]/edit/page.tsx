import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { getAdminCoupon } from "@/lib/admin/coupons";
import { PageHeader } from "@/components/admin/ui";
import { CouponForm } from "@/components/admin/coupons/coupon-form";

export async function generateMetadata({
  params,
}: PageProps<"/admin/marketing/coupons/[id]/edit">): Promise<Metadata> {
  const { id } = await params;
  const c = await getAdminCoupon(id);
  return { title: c ? `Edit ${c.code}` : "Edit coupon" };
}

export default async function EditCouponPage({
  params,
}: PageProps<"/admin/marketing/coupons/[id]/edit">) {
  await requirePermission("manage_coupons");
  const { id } = await params;
  const coupon = await getAdminCoupon(id);
  if (!coupon) notFound();

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href={`/admin/marketing/coupons/${id}`}
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Back to coupon
      </Link>
      <PageHeader title={`Edit ${coupon.code}`} />
      <CouponForm
        coupon={{
          id: coupon.id,
          code: coupon.code,
          description: coupon.description,
          type: coupon.type,
          value: coupon.value,
          maxDiscount: coupon.maxDiscount,
          minSubtotal: coupon.minSubtotal,
          startsAt: coupon.startsAt,
          expiresAt: coupon.expiresAt,
          usageLimit: coupon.usageLimit,
          perCustomerLimit: coupon.perCustomerLimit,
          active: coupon.active,
        }}
      />
    </div>
  );
}
