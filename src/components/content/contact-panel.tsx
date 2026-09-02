import { Mail, Phone, MapPin, Clock } from "lucide-react";
import type { SiteSettings } from "@/lib/site-settings";

/**
 * Contact details for the /pages/contact page (Step 19).
 *
 * Every value comes from Store Settings (Settings → Contact / Social). Nothing
 * is hardcoded. Rows render only when configured; if nothing is configured at
 * all, a plain fallback points the customer at order tracking. This never shows
 * an internal admin address — it only ever renders the configured public
 * `contact.email`.
 */
export function ContactPanel({ settings }: { settings: SiteSettings }) {
  const { contact, social } = settings;
  // Only treat it as a usable address when there's a street or city — a country
  // on its own ("Philippines") is not an address worth showing.
  const hasRealAddress = Boolean(contact.addressLine1.trim() || contact.city.trim());
  const addressParts = hasRealAddress
    ? [contact.addressLine1, contact.addressLine2, contact.city, contact.country]
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const rows: { icon: React.ReactNode; label: string; node: React.ReactNode }[] = [];

  if (contact.email) {
    rows.push({
      icon: <Mail size={16} aria-hidden />,
      label: "Email",
      node: (
        <a href={`mailto:${contact.email}`} className="underline underline-offset-2 hover:text-ink">
          {contact.email}
        </a>
      ),
    });
  }
  if (contact.phone) {
    rows.push({
      icon: <Phone size={16} aria-hidden />,
      label: "Phone",
      node: (
        <a
          href={`tel:${contact.phone.replace(/[^\d+]/g, "")}`}
          className="underline underline-offset-2 hover:text-ink"
        >
          {contact.phone}
        </a>
      ),
    });
  }
  if (addressParts.length > 0) {
    rows.push({
      icon: <MapPin size={16} aria-hidden />,
      label: "Address",
      node: <span>{addressParts.join(", ")}</span>,
    });
  }
  if (contact.hours) {
    rows.push({
      icon: <Clock size={16} aria-hidden />,
      label: "Hours",
      node: <span>{contact.hours}</span>,
    });
  }

  const hasAny = rows.length > 0 || social.length > 0;

  return (
    <section aria-labelledby="contact-details-heading" className="mt-10 rounded-lg border border-line bg-surface p-6 sm:p-8">
      <h2 id="contact-details-heading" className="font-display text-xl text-ink">
        Contact details
      </h2>

      {rows.length > 0 ? (
        <dl className="mt-5 space-y-4">
          {rows.map((r) => (
            <div key={r.label} className="flex gap-3">
              <span className="mt-0.5 shrink-0 text-ink-soft">{r.icon}</span>
              <div>
                <dt className="text-xs uppercase tracking-wide text-ink-faint">{r.label}</dt>
                <dd className="mt-0.5 text-body text-ink-soft">{r.node}</dd>
              </div>
            </div>
          ))}
        </dl>
      ) : (
        <p className="mt-4 text-body text-ink-soft">
          The quickest way to reach us about an order is{" "}
          <a href="/track" className="underline underline-offset-2 hover:text-ink">
            Track your order
          </a>
          . A public contact email and phone number can be added by an administrator in
          Settings&nbsp;→&nbsp;Contact.
        </p>
      )}

      {social.length > 0 && (
        <div className="mt-6 border-t border-line pt-5">
          <p className="text-xs uppercase tracking-wide text-ink-faint">Social</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {social.map((s) => (
              <a
                key={s.key}
                href={s.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="text-body text-ink-soft underline underline-offset-2 hover:text-ink"
              >
                {s.label}
              </a>
            ))}
          </div>
        </div>
      )}

      {!hasAny && <span className="sr-only">No contact channels configured.</span>}
    </section>
  );
}
