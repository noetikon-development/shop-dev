import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { PageHeader } from "@/components/admin/ui";
import { CouponForm } from "@/components/admin/coupons/coupon-form";

export const metadata: Metadata = { title: "New coupon" };

export default async function NewCouponPage() {
  await requirePermission("manage_coupons");

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/admin/marketing/coupons"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> All coupons
      </Link>
      <PageHeader title="New coupon" description="Create a discount code. Everything is validated server-side." />
      <CouponForm />
    </div>
  );
}
