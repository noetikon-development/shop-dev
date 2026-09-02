import Link from "next/link";
import { getCategoryTree } from "@/lib/data";
import { getSiteSettings } from "@/lib/site-settings";
import { getPublishedPageSlugs, getFooterBlock } from "@/lib/content";
import type { FooterData } from "@/lib/content-blocks";
import { FOOTER_DEFAULTS } from "@/lib/footer-defaults";
import { NAV_SPECIAL_SLUGS } from "@/lib/nav-defaults";
import type { CategoryNode } from "@/lib/types";
import { Logo } from "@/components/logo";
import { NewsletterForm } from "@/components/footer/newsletter-form";

/**
 * Site-wide footer.
 *
 * Customer-facing wording — brand line, column headings, link lists, newsletter
 * copy, copyright — comes from the `footer.default` ContentBlock (editable in
 * Admin → Content → Footer). Authoritative business values are NOT duplicated
 * there: the support email, social URLs and legal entity name are read from
 * Store Settings and merged in here.
 *
 * If the CMS block is missing, unpublished or unreachable, the built-in
 * fallback below keeps the footer rendering — it never disappears.
 */

type FooterLink = { label: string; href: string; enabled: boolean; categorySlug?: string };

/** Flatten the category tree to a set of every valid slug (roots + children). */
function allCategorySlugs(tree: CategoryNode[]): Set<string> {
  const set = new Set<string>();
  const walk = (n: CategoryNode) => {
    set.add(n.slug);
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return set;
}

export async function SiteFooter() {
  const [tree, settings, pageSlugs, block] = await Promise.all([
    getCategoryTree(),
    getSiteSettings(),
    getPublishedPageSlugs(),
    getFooterBlock(),
  ]);

  const data: FooterData = block ?? FOOTER_DEFAULTS;
  const published = new Set(pageSlugs);
  const year = new Date().getFullYear();

  /** Keep enabled links with a usable href; drop links to unpublished pages. */
  const usable = (links: FooterLink[]): FooterLink[] =>
    links.filter((l) => {
      if (!l.enabled || !l.label || !l.href) return false;
      if (l.href.startsWith("/pages/")) return published.has(l.href.slice("/pages/".length));
      return true;
    });

  const brandDescription = data.brandDescription || settings.description;

  // Shop column (Phase 5C): an explicit, editable link list from the CMS wins.
  // Each link may reference a category slug — the destination is then derived as
  // `/c/<slug>` and can never be broken by editing the label. When the CMS list
  // is empty (or every entry is unusable) the footer falls back to the category
  // tree, so the Shop column never disappears.
  const catSlugs = allCategorySlugs(tree);
  const validSlug = (s: string) =>
    catSlugs.has(s) || (NAV_SPECIAL_SLUGS as readonly string[]).includes(s);

  const shopLinks: { label: string; href: string }[] = data.shopColumn.links
    .filter((l) => l.enabled && l.label)
    .map((l) => ({
      label: l.label,
      href: l.categorySlug && validSlug(l.categorySlug) ? `/c/${l.categorySlug}` : l.href,
    }))
    .filter((l) => {
      if (!l.href) return false;
      if (l.href.startsWith("/pages/")) return published.has(l.href.slice("/pages/".length));
      return (l.href.startsWith("/") && !l.href.startsWith("//")) || /^https:\/\//i.test(l.href);
    });

  const shopFromTree: { label: string; href: string }[] =
    shopLinks.length === 0
      ? [
          ...tree.slice(0, 7).map((c) => ({ label: c.name, href: `/c/${c.slug}` })),
          { label: "Sale", href: "/c/sale" },
        ]
      : [];

  const helpLinks = usable(data.helpColumn.links);
  const companyLinks = usable(data.companyColumn.links);
  const legalLinks = usable(data.legalLinks);

  const copyright = (data.copyright || FOOTER_DEFAULTS.copyright)
    .replace(/\{year\}/g, String(year))
    .replace(/\{brand\}/g, settings.business.legalName || settings.brand);

  const nl = data.newsletter;

  return (
    <footer className="mt-20 border-t border-line bg-surface">
      <div className="container-page py-12 sm:py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo className="h-11" src={settings.logoUrl} alt={settings.brand} />
            {brandDescription && (
              <p className="mt-4 max-w-xs text-meta text-ink-soft">{brandDescription}</p>
            )}
            {settings.social.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2">
                {settings.social.map((s) => (
                  <a
                    key={s.key}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-meta text-ink-soft underline underline-offset-4 transition-colors hover:text-ink"
                  >
                    {s.label}
                  </a>
                ))}
              </div>
            )}
            {(nl.heading || nl.body || nl.successText) && (
              <div className="mt-6">
                {nl.heading && <p className="eyebrow mb-2">{nl.heading}</p>}
                {nl.body && <p className="mb-2 text-meta text-ink-soft">{nl.body}</p>}
                <NewsletterForm ctaLabel={nl.ctaLabel} successText={nl.successText} />
              </div>
            )}
          </div>

          {/* The three CMS link columns: a 2-up grid on mobile, 3-up from `sm`,
              and dissolved into the 4-column footer row at `lg` (lg:contents).
              This keeps the mobile footer compact without dropping any link. */}
          <div className="grid grid-cols-2 gap-x-6 gap-y-9 sm:grid-cols-3 lg:contents">
            <FooterCol title={data.shopColumn.heading || "Shop"}>
              {(shopLinks.length > 0 ? shopLinks : shopFromTree).map((l, i) => (
                <FooterLinkItem key={`s${i}`} href={l.href}>
                  {l.label}
                </FooterLinkItem>
              ))}
            </FooterCol>

            <FooterCol title={data.helpColumn.heading || "Help"}>
              {helpLinks.map((l, i) => (
                <FooterLinkItem key={`h${i}`} href={l.href}>
                  {l.label}
                </FooterLinkItem>
              ))}
            </FooterCol>

            <FooterCol title={data.companyColumn.heading || "Company"}>
              {companyLinks.length > 0 ? (
                companyLinks.map((l, i) => (
                  <FooterLinkItem key={`c${i}`} href={l.href}>
                    {l.label}
                  </FooterLinkItem>
                ))
              ) : (
                <li className="text-meta text-ink-faint">Coming soon</li>
              )}
              {settings.contact.email && (
                <FooterLinkItem href={`mailto:${settings.contact.email}`}>
                  {settings.contact.email}
                </FooterLinkItem>
              )}
            </FooterCol>
          </div>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 text-meta text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>{copyright}</p>
          {legalLinks.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {legalLinks.map((l, i) => (
                <Link key={`l${i}`} href={l.href} className="hover:text-ink">
                  {l.label}
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}

function FooterCol({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="eyebrow mb-3">{title}</p>
      <ul className="space-y-2">{children}</ul>
    </div>
  );
}

function FooterLinkItem({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = "text-meta text-ink-soft transition-colors hover:text-ink";
  return (
    <li>
      {href.startsWith("/") ? (
        <Link href={href} className={cls}>
          {children}
        </Link>
      ) : (
        <a href={href} className={cls}>
          {children}
        </a>
      )}
    </li>
  );
}
