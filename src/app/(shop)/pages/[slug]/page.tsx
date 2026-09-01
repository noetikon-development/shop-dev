import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublishedPage } from "@/lib/content";
import { getSiteSettings } from "@/lib/site-settings";
import { Markdown } from "@/lib/markdown";
import { PageHeader } from "@/components/ui/page-header";
import { ContactPanel } from "@/components/content/contact-panel";
import { ContactForm } from "@/components/content/contact-form";
import { formatDate } from "@/lib/utils";

export async function generateMetadata({ params }: PageProps<"/pages/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) return { title: "Not found" };
  const settings = await getSiteSettings();
  const title = page.seoTitle || page.title;
  const description = page.seoDescription || page.excerpt || settings.seo.defaultDescription;
  return {
    title,
    description,
    alternates: { canonical: `/pages/${slug}` },
    openGraph: {
      title,
      description: description || undefined,
      type: "article",
      url: `/pages/${slug}`,
    },
  };
}

/** Policy slugs that carry a short "general information, not legal advice" note. */
const LEGAL_SLUGS = new Set([
  "privacy",
  "terms",
  "cookies",
  "cancellation",
  "returns",
  "shipping",
]);

export default async function ContentPageView({ params }: PageProps<"/pages/[slug]">) {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) notFound();

  const settings = slug === "contact" ? await getSiteSettings() : null;

  return (
    <article className="container-page py-10 sm:py-16">
      <div className="mx-auto max-w-2xl">
        <PageHeader
          title={page.title}
          description={page.excerpt || undefined}
          meta={`Last updated ${formatDate(page.updatedAt)}`}
          className="mb-0"
        />
        <div className="mt-8 border-t border-line pt-8 text-body">
          <Markdown source={page.body} />
        </div>
        {LEGAL_SLUGS.has(slug) && (
          <p className="mt-10 rounded-md border border-line bg-surface-sunken/50 p-3 text-xs text-ink-faint">
            This policy is provided for general information and is not legal advice. If you have a
            question about how it applies to you, please{" "}
            <Link href="/pages/contact" className="underline underline-offset-2 hover:text-ink">
              contact us
            </Link>
            .
          </p>
        )}
        {settings && (
          <>
            <ContactForm />
            <ContactPanel settings={settings} />
          </>
        )}
      </div>
    </article>
  );
}
