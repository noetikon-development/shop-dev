import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublishedPage } from "@/lib/content";
import { getSiteSettings } from "@/lib/site-settings";
import { Markdown } from "@/lib/markdown";
import { formatDate } from "@/lib/utils";

export async function generateMetadata({ params }: PageProps<"/pages/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) return { title: "Not found" };
  const settings = await getSiteSettings();
  return {
    title: page.seoTitle || page.title,
    description: page.seoDescription || page.excerpt || settings.seo.defaultDescription,
    openGraph: {
      title: page.seoTitle || page.title,
      description: page.seoDescription || page.excerpt || undefined,
      type: "article",
    },
  };
}

export default async function ContentPageView({ params }: PageProps<"/pages/[slug]">) {
  const { slug } = await params;
  const page = await getPublishedPage(slug);
  if (!page) notFound();

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
      </div>
    </article>
  );
}
