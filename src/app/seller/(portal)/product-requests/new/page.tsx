import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { listRequestCategoryOptions } from "@/lib/seller/product-requests";
import { PageHeader, Card } from "@/components/seller/ui";
import { RequestForm } from "@/components/seller/request-form";

export const metadata: Metadata = { title: "Request a product" };

export default async function NewSellerProductRequestPage() {
  await requireSellerSessionPermission("manage_offers");
  const categories = await listRequestCategoryOptions();

  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/seller/product-requests"
        className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ArrowLeft size={14} /> Back to product requests
      </Link>
      <PageHeader
        title="Request a product"
        description="Tell Axiaro about a product it doesn't carry. This is a proposal — Axiaro reviews it, curates the catalog entry, and creates the canonical product. You then list against it."
      />
      <Card>
        <RequestForm mode="create" categories={categories} />
      </Card>
    </div>
  );
}
