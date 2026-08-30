import Link from "next/link";
import { getCategoryTree } from "@/lib/data";
import { getSiteSettings } from "@/lib/site-settings";
import { getPublishedPageSlugs } from "@/lib/content";
import { Logo } from "@/components/logo";
import { NewsletterForm } from "@/components/footer/newsletter-form";

// Content pages the footer links to when they exist and are published.
const HELP_PAGES = [
  { slug: "shipping", label: "Shipping & delivery" },
  { slug: "returns", label: "Returns & exchanges" },
  { slug: "care", label: "Assembly & care" },
  { slug: "faq", label: "FAQ" },
  { slug: "contact", label: "Contact us" },
];
const COMPANY_PAGES = [
  { slug: "about", label: "About us" },
  { slug: "materials", label: "Our materials" },
  { slug: "sustainability", label: "Sustainability" },
  { slug: "stores", label: "Stores" },
];
const LEGAL_PAGES = [
  { slug: "privacy", label: "Privacy" },
  { slug: "terms", label: "Terms" },
  { slug: "cookies", label: "Cookies" },
  { slug: "cancellation", label: "Cancellation" },
];

export async function SiteFooter() {
  const [tree, settings, pageSlugs] = await Promise.all([
    getCategoryTree(),
    getSiteSettings(),
    getPublishedPageSlugs(),
  ]);
  const has = new Set(pageSlugs);
  const help: { slug: string; label: string; href?: string }[] = [
    { slug: "", label: "Track your order", href: "/track" },
    ...HELP_PAGES.filter((p) => has.has(p.slug)),
  ];
  const company = COMPANY_PAGES.filter((p) => has.has(p.slug));
  const legal = LEGAL_PAGES.filter((p) => has.has(p.slug));
  const year = new Date().getFullYear();

  return (
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="container-page py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo className="h-11" src={settings.logoUrl} alt={settings.brand} />
            <p className="mt-4 max-w-xs text-sm text-ink-soft">{settings.description}</p>
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
            <div className="mt-6">
              <p className="eyebrow mb-2">Get 10% off your first order</p>
              <NewsletterForm />
            </div>
          </div>

          <FooterCol title="Shop">
            {tree.slice(0, 7).map((c) => (
              <FooterLink key={c.id} href={`/c/${c.slug}`}>
                {c.name}
              </FooterLink>
            ))}
            <FooterLink href="/c/sale">Sale</FooterLink>
          </FooterCol>

          <FooterCol title="Help">
            {help.map((l) => (
              <FooterLink key={l.slug || l.href} href={l.href ?? `/pages/${l.slug}`}>
                {l.label}
              </FooterLink>
            ))}
          </FooterCol>

          <FooterCol title="Company">
            {company.length > 0 ? (
              company.map((l) => (
                <FooterLink key={l.slug} href={`/pages/${l.slug}`}>
                  {l.label}
                </FooterLink>
              ))
            ) : (
              <li className="text-sm text-ink-faint">Coming soon</li>
            )}
            {settings.contact.email && (
              <FooterLink href={`mailto:${settings.contact.email}`}>{settings.contact.email}</FooterLink>
            )}
          </FooterCol>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {year} {settings.business.legalName || settings.brand}. All rights reserved.
          </p>
          {legal.length > 0 && (
            <div className="flex flex-wrap gap-4">
              {legal.map((l) => (
                <Link key={l.slug} href={`/pages/${l.slug}`} className="hover:text-ink">
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

function FooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <Link href={href} className="text-sm text-ink-soft transition-colors hover:text-ink">
        {children}
      </Link>
    </li>
  );
}
