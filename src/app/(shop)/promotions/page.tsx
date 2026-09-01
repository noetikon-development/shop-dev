import Link from "next/link";
import type { Metadata } from "next";
import { Tag, ArrowRight } from "lucide-react";
import { prisma } from "@/lib/prisma";
import { getOnSale } from "@/lib/data";
import { ProductRail } from "@/components/product-rail";
import { formatPrice } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Promotions",
  description: "Current Axiaro promo codes and markdowns.",
  alternates: { canonical: "/promotions" },
};

export default async function PromotionsPage() {
  const now = new Date();
  const [coupons, onSale] = await Promise.all([
    prisma.coupon.findMany({
      where: {
        active: true,
        archivedAt: null,
        type: { in: ["PERCENT", "FIXED"] }, // free-shipping coupons are a later step
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        ],
      },
      orderBy: { value: "desc" },
    }),
    getOnSale(12),
  ]);

  return (
    <div className="pb-10">
      <div className="container-page py-10">
        <p className="eyebrow">Promotions</p>
        <h1 className="mt-2 max-w-2xl text-3xl sm:text-display">
          Codes and markdowns, all in one place
        </h1>
        <p className="mt-3 max-w-xl text-ink-soft">
          Apply a code at checkout. One promo code per order; markdowns already applied to sale
          prices.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {coupons.map((c) => (
            <div
              key={c.id}
              className="flex items-start justify-between gap-4 rounded-lg border border-dashed border-line-strong bg-surface p-5"
            >
              <div>
                <p className="inline-flex items-center gap-2 font-display text-xl">
                  <Tag size={16} className="text-clay" />
                  {c.code}
                </p>
                <p className="mt-1.5 text-sm text-ink-soft">{c.description}</p>
                {c.minSubtotal > 0 && (
                  <p className="mt-1 text-xs text-ink-faint">
                    Minimum spend {formatPrice(c.minSubtotal)}
                  </p>
                )}
              </div>
              <Link href="/c/all" className="btn btn-outline shrink-0 !py-2 text-sm">
                Shop <ArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      </div>

      <ProductRail
        eyebrow="Reduced"
        title="On sale now"
        action={{ label: "All sale items", href: "/c/sale" }}
        products={onSale}
        showCategory
      />
    </div>
  );
}
