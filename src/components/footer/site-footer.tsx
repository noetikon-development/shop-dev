import Link from "next/link";
import { getCategoryTree } from "@/lib/data";
import { getSiteSettings } from "@/lib/site-settings";
import { getPublishedPageSlugs, getFooterBlock } from "@/lib/content";
import type { FooterData } from "@/lib/content-blocks";
import { FOOTER_DEFAULTS } from "@/lib/footer-defaults";
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

type FooterLink = { label: string; href: string; enabled: boolean };

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

  // Shop column: curated links from the block, or the category tree when empty.
  const shopLinks: FooterLink[] = usable(data.shopColumn.links);
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
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="container-page py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo className="h-11" src={settings.logoUrl} alt={settings.brand} />
            {brandDescription && (
              <p className="mt-4 max-w-xs text-sm text-ink-soft">{brandDescription}</p>
            )}
            {settings.social.length > 0 && (
              <div className="mt-5 flex flex-wrap gap-x-4 gap-y-2">
                {settings.social.map((s) => (
                  <a
                    key={s.key}
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-sm text-ink-soft underline underline-offset-4 transition-colors hover:text-ink"
                  >
                    {s.label}
                  </a>
                ))}
              </div>
            )}
            {(nl.heading || nl.body || nl.successText) && (
              <div className="mt-6">
                {nl.heading && <p className="eyebrow mb-2">{nl.heading}</p>}
                {nl.body && <p className="mb-2 text-sm text-ink-soft">{nl.body}</p>}
                <NewsletterForm ctaLabel={nl.ctaLabel} successText={nl.successText} />
              </div>
            )}
          </div>

          <FooterCol title={data.shopColumn.heading || "Shop"}>
            {shopFromTree.map((c, i) => (
              <FooterLinkItem key={`s${i}`} href={c.href}>
                {c.label}
              </FooterLinkItem>
            ))}
            {shopLinks.map((l, i) => (
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
              <li className="text-sm text-ink-faint">Coming soon</li>
            )}
            {settings.contact.email && (
              <FooterLinkItem href={`mailto:${settings.contact.email}`}>
                {settings.contact.email}
              </FooterLinkItem>
            )}
          </FooterCol>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>{copyright}</p>
          {legalLinks.length > 0 && (
            <div className="flex flex-wrap gap-4">
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
      <p className="eyebrow mb-3.5">{title}</p>
      <ul className="space-y-2.5">{children}</ul>
    </div>
  );
}

function FooterLinkItem({ href, children }: { href: string; children: React.ReactNode }) {
  const cls = "text-sm text-ink-soft transition-colors hover:text-ink";
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
