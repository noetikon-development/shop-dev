import Link from "next/link";
import type { Metadata } from "next";
import { getCategoryTree } from "@/lib/data";
import { getSiteSettings } from "@/lib/site-settings";
import { Breadcrumbs } from "@/components/ui/breadcrumbs";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * Full category-tree discovery page ("All Categories" — 9F-navigation-audit
 * follow-up). Distinct from `/c/all`, which is the "All products" flat
 * catalogue listing and is untouched by this page.
 *
 * Read-only presentation of `getCategoryTree()` — the SAME active-only,
 * sortOrder-ordered, department -> sub-category hierarchy the mega-menu and
 * homepage category tiles already use. This page adds no filtering logic of
 * its own: it faithfully mirrors whatever that function returns, so it can
 * never drift from the rest of the storefront's category rules (active
 * status, ordering) by construction.
 *
 * Deliberately does NOT introduce a third hierarchy level — every department
 * here is a `CategoryNode` from the tree's roots, and only its direct
 * `children` (one level) are listed, matching the two-level model the rest
 * of the storefront (breadcrumbs, mega-menu dropdowns) already assumes.
 */

export async function generateMetadata(): Promise<Metadata> {
  const settings = await getSiteSettings();
  return {
    title: "All Categories",
    description: `Browse every department and category at ${settings.brand}.`,
    alternates: { canonical: "/categories" },
  };
}

export default async function AllCategoriesPage() {
  const departments = await getCategoryTree();

  return (
    <div className="container-page py-6 sm:py-8">
      <Breadcrumbs className="mb-4" items={[{ label: "Home", href: "/" }, { label: "All Categories" }]} />

      <PageHeader
        title="All Categories"
        description="Browse every department and category — the complete way to find what you're looking for."
      />

      {departments.length === 0 ? (
        <EmptyState
          title="No categories available right now"
          message="Check back shortly — we're adding departments and categories."
        />
      ) : (
        <div className="grid grid-cols-1 gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {departments.map((dept) => (
            <section key={dept.id} aria-labelledby={`dept-${dept.id}`}>
              <h2 id={`dept-${dept.id}`} className="text-subtitle">
                <Link href={`/c/${dept.slug}`} className="link-underline">
                  {dept.name}
                </Link>
              </h2>

              {dept.children.length > 0 && (
                <ul className="mt-3 space-y-2 border-t border-line pt-3">
                  {dept.children.map((child) => (
                    <li key={child.id}>
                      <Link
                        href={`/c/${child.slug}`}
                        className="flex items-baseline justify-between gap-2 text-body text-ink-soft transition-colors hover:text-ink"
                      >
                        <span>{child.name}</span>
                        {child.productCount != null && (
                          <span className="text-meta text-ink-faint">{child.productCount}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
