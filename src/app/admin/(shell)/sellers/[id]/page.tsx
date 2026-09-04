import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePermission } from "@/lib/admin/rbac";
import { getAdminSellerContent } from "@/lib/admin/seller-content";
import { countryName } from "@/lib/countries";
import { SELLER_SOCIAL_KEYS } from "@/lib/marketplace/types";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { SellerContentReviewPanel } from "@/components/admin/sellers/review-panel";

export const metadata: Metadata = { title: "Seller profile review" };

const TONE = { DRAFT: "neutral", PENDING: "info", APPROVED: "success" } as const;
const LABEL = { DRAFT: "Draft", PENDING: "In review", APPROVED: "Approved" } as const;

export default async function AdminSellerContentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("manage_content");
  const { id } = await params;
  const s = await getAdminSellerContent(id);
  if (!s) notFound();

  const social = SELLER_SOCIAL_KEYS.map((k) => [k, s.profile.socialLinks[k]] as const).filter(
    ([, v]) => Boolean(v),
  );

  return (
    <div>
      <Link href="/admin/sellers" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> Seller content
      </Link>
      <PageHeader
        title={s.displayName}
        description={`/${s.slug} · seller account ${s.sellerStatus.toLowerCase()}`}
        actions={<StatusBadge tone={TONE[s.contentStatus]}>{LABEL[s.contentStatus]}</StatusBadge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Submitted profile</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <Preview label="Logo" url={s.profile.logoUrl} />
              <Preview label="Banner" url={s.profile.bannerUrl} />
            </div>
            <Field label="About">{s.profile.bio}</Field>
            <Field label="Return policy summary">{s.profile.returnPolicy}</Field>
            <Field label="Shipping policy summary">{s.profile.shippingPolicy}</Field>
            <Field label="Ships from">
              {[s.profile.shipFromCity, s.profile.shipFromCountry ? countryName(s.profile.shipFromCountry) : null]
                .filter(Boolean)
                .join(", ") || null}
            </Field>
            <div className="mt-3">
              <p className="text-xs font-medium text-ink-faint">Social links</p>
              {social.length === 0 ? (
                <p className="text-sm text-ink-faint">—</p>
              ) : (
                <ul className="mt-1 space-y-0.5 text-sm">
                  {social.map(([k, v]) => (
                    <li key={k}>
                      <span className="capitalize text-ink-soft">{k}:</span>{" "}
                      <span className="break-all">{v}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold">Review history</h2>
            {s.history.length === 0 ? (
              <p className="text-sm text-ink-faint">No review activity yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {s.history.map((h, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="shrink-0 text-xs text-ink-faint">
                      {new Date(h.at).toLocaleString()}
                    </span>
                    <span className="text-ink-soft">{h.summary ?? h.action}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <h2 className="mb-2 text-sm font-semibold">Review</h2>
            {s.contentStatus === "PENDING" ? (
              <SellerContentReviewPanel sellerId={s.sellerId} />
            ) : (
              <p className="text-sm text-ink-soft">
                {s.contentStatus === "APPROVED"
                  ? "This profile is approved. It returns here for review when the seller next edits it."
                  : "Nothing to review — the seller has not submitted this profile."}
              </p>
            )}
            {s.reviewNote && (
              <div className="mt-3 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
                <p className="font-medium">Last note{s.reviewedByEmail ? ` · ${s.reviewedByEmail}` : ""}</p>
                <p className="mt-1 whitespace-pre-wrap">{s.reviewNote}</p>
              </div>
            )}
          </Card>
          <Card>
            <h2 className="mb-2 text-sm font-semibold">Contact</h2>
            <p className="text-sm text-ink-soft">{s.supportEmail}</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-ink-faint">{label}</p>
      {children ? (
        <p className="whitespace-pre-wrap text-sm text-ink">{children}</p>
      ) : (
        <p className="text-sm text-ink-faint">—</p>
      )}
    </div>
  );
}

function Preview({ label, url }: { label: string; url: string | null }) {
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-ink-faint">{label}</p>
      <div className="relative h-24 overflow-hidden rounded-sm border border-line bg-surface-sunken">
        {url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={`${label} preview`} className="h-full w-full object-contain" />
        ) : (
          <div className="grid h-full place-items-center text-[11px] text-ink-faint">Not set</div>
        )}
      </div>
    </div>
  );
}
