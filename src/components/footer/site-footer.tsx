import Link from "next/link";
import { getCategoryTree } from "@/lib/data";
import { Logo } from "@/components/logo";
import { SITE } from "@/lib/constants";
import { NewsletterForm } from "@/components/footer/newsletter-form";

const HELP_LINKS = [
  { label: "Track your order", href: "/track" },
  { label: "Shipping & delivery", href: "/help/shipping" },
  { label: "Returns & exchanges", href: "/help/returns" },
  { label: "Assembly & care", href: "/help/care" },
  { label: "Contact us", href: "/help/contact" },
];

const COMPANY_LINKS = [
  { label: "Our materials", href: "/about/materials" },
  { label: "Sustainability", href: "/about/sustainability" },
  { label: "Stores", href: "/about/stores" },
  { label: "Careers", href: "/about/careers" },
];

export async function SiteFooter() {
  const tree = await getCategoryTree();

  return (
    <footer className="mt-24 border-t border-line bg-surface">
      <div className="container-page py-14">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <Logo className="h-11" />
            <p className="mt-4 max-w-xs text-sm text-ink-soft">{SITE.description}</p>
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
            {HELP_LINKS.map((l) => (
              <FooterLink key={l.href} href={l.href}>
                {l.label}
              </FooterLink>
            ))}
          </FooterCol>

          <FooterCol title="Company">
            {COMPANY_LINKS.map((l) => (
              <FooterLink key={l.href} href={l.href}>
                {l.label}
              </FooterLink>
            ))}
          </FooterCol>
        </div>

        <div className="mt-12 flex flex-col gap-4 border-t border-line pt-6 text-xs text-ink-faint sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 Axiaro. All Rights Reserved.</p>
          <div className="flex flex-wrap gap-4">
            <Link href="/legal/privacy" className="hover:text-ink">
              Privacy
            </Link>
            <Link href="/legal/terms" className="hover:text-ink">
              Terms
            </Link>
            <Link href="/legal/cookies" className="hover:text-ink">
              Cookies
            </Link>
          </div>
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
