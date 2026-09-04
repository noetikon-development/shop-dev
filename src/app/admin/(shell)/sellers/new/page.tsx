import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { DEFAULT_SELLER_COMMISSION_BPS } from "@/lib/admin/sellers/lifecycle";
import { PageHeader, Card } from "@/components/admin/ui";
import { CreateSellerForm } from "@/components/admin/sellers/create-seller-form";

export const metadata: Metadata = { title: "New seller" };

export default async function NewSellerPage() {
  await requirePermission("manage_settings");

  return (
    <div className="mx-auto max-w-2xl">
      <Link href="/admin/sellers" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> Sellers
      </Link>
      <PageHeader
        title="New seller"
        description="Creates a third-party seller in PENDING. Approve it from the seller page once onboarding checks are done. It stays invisible to customers until multi-seller checkout is enabled."
      />
      <Card>
        <CreateSellerForm defaultCommissionBps={DEFAULT_SELLER_COMMISSION_BPS} />
      </Card>
    </div>
  );
}
