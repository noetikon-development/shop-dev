import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublishedPage } from "@/lib/content";
import { getSiteSettings } from "@/lib/site-settings";
import { Markdown } from "@/lib/markdown";
import { ContactPanel } from "@/components/content/contact-panel";
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

/** Slugs whose content is a general template, not vetted legal advice. */
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
        <h1 className="text-3xl sm:text-[2.5rem]">{page.title}</h1>
        {page.excerpt && <p className="mt-3 text-pretty text-ink-soft">{page.excerpt}</p>}
        <p className="mt-2 text-xs text-ink-faint">
          Last updated {formatDate(page.updatedAt)}
        </p>
        <div className="mt-8 border-t border-line pt-8 text-[15px]">
          <Markdown source={page.body} />
        </div>
        {LEGAL_SLUGS.has(slug) && (
          <p className="mt-10 rounded-md border border-line bg-surface-sunken/50 p-3 text-xs text-ink-faint">
            This page is a general template. Have the final wording reviewed by a qualified
            professional for your business before relying on it commercially.
          </p>
        )}
        {settings && <ContactPanel settings={settings} />}
      </div>
    </article>
  );
}
