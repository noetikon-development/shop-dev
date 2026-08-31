import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireUser } from "@/lib/auth";
import { returnEligibility, describeIneligibility } from "@/lib/returns";
import { ReturnRequestForm } from "@/components/returns/return-request-form";

export async function generateMetadata({
  params,
}: PageProps<"/account/orders/[orderNumber]/return">): Promise<Metadata> {
  const { orderNumber } = await params;
  return { title: `Return items · Order ${orderNumber}` };
}

export default async function StartReturnPage({
  params,
}: PageProps<"/account/orders/[orderNumber]/return">) {
  const { orderNumber } = await params;
  const user = await requireUser(`/account/orders/${orderNumber}/return`);
  const elig = await returnEligibility(user.id, orderNumber);

  if (!elig.eligible && elig.code === "not_found") notFound();

  return (
    <div className="space-y-6">
      <Link
        href={`/account/orders/${orderNumber}`}
        className="inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink"
      >
        <ChevronLeft size={15} /> Back to order
      </Link>
      <div>
        <h2 className="text-xl">Return items from order {orderNumber}</h2>
        <p className="mt-1.5 text-sm text-ink-soft">
          Choose what you&apos;d like to return and tell us why. We&apos;ll review your request and
          email you the next steps.
        </p>
      </div>

      {elig.eligible ? (
        <ReturnRequestForm
          orderNumber={orderNumber}
          lines={elig.lines.map((l) => ({
            orderItemId: l.orderItemId,
            name: l.name,
            variantLabel: l.variantLabel,
            sku: l.sku,
            unitPrice: l.unitPrice,
            remaining: l.remaining,
          }))}
        />
      ) : (
        <div className="card-surface p-5">
          <p className="text-sm text-ink-soft">{describeIneligibility(elig.code)}</p>
          {elig.code === "already_open" && elig.existingReturnNumber && (
            <Link
              href={`/account/returns/${elig.existingReturnNumber}`}
              className="btn btn-outline mt-4"
            >
              View your return
            </Link>
          )}
          {elig.code !== "already_open" && (
            <Link href={`/account/orders/${orderNumber}`} className="btn btn-outline mt-4">
              Back to order
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
