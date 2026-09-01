import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronRight } from "lucide-react";
import {
  getProductBySlug,
  getProductReviews,
  getReviewSummary,
  getRelatedProducts,
} from "@/lib/data";
import { getCurrentUser } from "@/lib/auth";
import { reviewEligibility, getMyReview } from "@/lib/reviews";
import { getPublicQA, getMyQuestions } from "@/lib/qa";
import { ProductViewer } from "@/components/pdp/product-viewer";
import { DetailsAccordion } from "@/components/pdp/details-accordion";
import { Reviews } from "@/components/pdp/reviews";
import { ProductQA } from "@/components/pdp/product-qa";
import { ProductRail } from "@/components/product-rail";
import { getSiteSettings } from "@/lib/site-settings";
import { Markdown } from "@/lib/markdown";

export async function generateMetadata({
  params,
}: PageProps<"/p/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) return { title: "Not found" };
  const settings = await getSiteSettings();
  return {
    title: product.name,
    description: product.shortDescription,
    alternates: { canonical: `/p/${slug}` },
    openGraph: {
      title: `${product.name} | ${settings.brand}`,
      description: product.shortDescription,
      type: "website",
      url: `/p/${slug}`,
    },
  };
}

export default async function ProductPage({ params }: PageProps<"/p/[slug]">) {
  const { slug } = await params;
  const product = await getProductBySlug(slug);
  if (!product) notFound();

  const user = await getCurrentUser();

  const [reviews, summary, related, publicQA, settings] = await Promise.all([
    getProductReviews(product.id),
    getReviewSummary(product.id),
    getRelatedProducts(product.categorySlug, product.slug, 8),
    getPublicQA(product.id),
    getSiteSettings(),
  ]);

  let eligibility: Awaited<ReturnType<typeof reviewEligibility>> = { eligible: false, orderId: null };
  let myReview: Awaited<ReturnType<typeof getMyReview>> = null;
  let myQuestions: Awaited<ReturnType<typeof getMyQuestions>> = [];
  if (user) {
    [eligibility, myReview, myQuestions] = await Promise.all([
      reviewEligibility(user.id, product.id),
      getMyReview(user.id, product.id),
      getMyQuestions(user.id, product.id),
    ]);
  }

  const specEntries = Object.entries(product.specs);

  return (
    <div className="pb-10">
      <div className="container-page py-5">
        <nav className="flex flex-wrap items-center gap-1.5 text-xs text-ink-faint">
          <Link href="/" className="hover:text-ink">
            Home
          </Link>
          <ChevronRight size={12} />
          <Link href={`/c/${product.categorySlug}`} className="hover:text-ink">
            {product.categoryName}
          </Link>
          <ChevronRight size={12} />
          <span className="text-ink">{product.name}</span>
        </nav>
      </div>

      <div className="container-page">
        <ProductViewer product={product} />
      </div>

      {/* Details */}
      <div className="container-page mt-16 grid gap-12 lg:grid-cols-[1fr_1.4fr] lg:gap-20">
        <div>
          <h2 className="text-2xl sm:text-title">About this piece</h2>
          <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-ink-soft">
            {product.description.split("\n").map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        </div>

        <DetailsAccordion
          sections={[
            ...(specEntries.length
              ? [
                  {
                    id: "specs",
                    title: "Specifications",
                    content: (
                      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
                        {specEntries.map(([k, v]) => (
                          <div
                            key={k}
                            className="flex justify-between gap-4 border-b border-line/70 py-2"
                          >
                            <dt className="text-ink-faint">{k}</dt>
                            <dd className="text-right font-medium text-ink">{v}</dd>
                          </div>
                        ))}
                      </dl>
                    ),
                  },
                ]
              : []),
            ...(product.care
              ? [{ id: "care", title: "Care", content: <p>{product.care}</p> }]
              : []),
            ...(settings.pdp.shipping
              ? [
                  {
                    id: "shipping",
                    title: "Shipping & returns",
                    content: <Markdown source={settings.pdp.shipping} />,
                  },
                ]
              : []),
            ...(settings.pdp.guarantee
              ? [
                  {
                    id: "guarantee",
                    title: "Our guarantee",
                    content: <Markdown source={settings.pdp.guarantee} />,
                  },
                ]
              : []),
          ]}
        />
      </div>

      {/* Reviews */}
      <div className="container-page mt-20">
        <Reviews
          reviews={reviews}
          summary={summary}
          productId={product.id}
          canReview={eligibility.eligible}
          myReview={myReview}
        />
      </div>

      {/* Questions & answers */}
      <div className="container-page mt-16">
        <ProductQA
          productId={product.id}
          questions={publicQA}
          myQuestions={myQuestions}
          signedIn={Boolean(user)}
        />
      </div>

      {/* Related */}
      <div className="mt-20">
        <ProductRail
          eyebrow="You might also like"
          title={`More from ${product.categoryName}`}
          products={related}
        />
      </div>
    </div>
  );
}
