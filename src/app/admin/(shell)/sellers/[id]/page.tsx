import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requireAnyPermission } from "@/lib/admin/rbac";
import {
  getAdminSeller,
  listSellerOffersForAdmin,
  listSellerProductRequestsForAdmin,
} from "@/lib/admin/sellers/repository";
import { sellerStatusLabel, sellerStatusTone } from "@/lib/admin/sellers/lifecycle";
import { countryName } from "@/lib/countries";
import { SELLER_SOCIAL_KEYS } from "@/lib/marketplace/types";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";
import { SellerContentReviewPanel } from "@/components/admin/sellers/review-panel";
import { SellerLifecyclePanel } from "@/components/admin/sellers/seller-lifecycle-panel";
import { SellerConfigForm } from "@/components/admin/sellers/seller-config-form";
import { SellerUsersPanel } from "@/components/admin/sellers/seller-users-panel";

export const metadata: Metadata = { title: "Seller" };

const CONTENT_TONE = { DRAFT: "neutral", PENDING: "info", APPROVED: "success" } as const;
const CONTENT_LABEL = { DRAFT: "Draft", PENDING: "In review", APPROVED: "Approved" } as const;

export default async function AdminSellerDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const admin = await requireAnyPermission(["manage_settings", "manage_content"]);
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_settings");
  const canReviewContent = admin.isSuperAdmin || admin.permissions.has("manage_content");

  const { id } = await params;
  const [s, listings, requests] = await Promise.all([
    getAdminSeller(id),
    listSellerOffersForAdmin(id, { limit: 100 }),
    listSellerProductRequestsForAdmin(id, { limit: 50 }),
  ]);
  if (!s) notFound();

  const social = SELLER_SOCIAL_KEYS.map((k) => [k, s.profile.socialLinks[k]] as const).filter(([, v]) => Boolean(v));

  return (
    <div>
      <Link href="/admin/sellers" className="mb-4 inline-flex items-center gap-1 text-sm text-ink-soft hover:text-ink">
        <ChevronLeft size={15} /> Sellers
      </Link>
      <PageHeader
        title={s.displayName}
        description={`/${s.slug} · ${s.type === "FIRST_PARTY" ? "first-party" : "third-party"}`}
        actions={<StatusBadge tone={sellerStatusTone(s.status)}>{sellerStatusLabel(s.status)}</StatusBadge>}
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card>
            <h2 className="mb-3 text-sm font-semibold">Overview</h2>
            <dl className="grid gap-3 sm:grid-cols-2 text-sm">
              <div><dt className="text-xs text-ink-faint">Support email</dt><dd>{s.supportEmail}</dd></div>
              <div><dt className="text-xs text-ink-faint">Notification email</dt><dd>{s.notifyEmail ?? "—"}</dd></div>
              {canManage && (
                <div><dt className="text-xs text-ink-faint">Commission</dt><dd>{(s.commissionRate / 100).toFixed(2)}% ({s.commissionRate} bps)</dd></div>
              )}
              <div><dt className="text-xs text-ink-faint">Created</dt><dd>{new Date(s.createdAt).toLocaleString()}</dd></div>
              <div>
                <dt className="text-xs text-ink-faint">Offers</dt>
                <dd>
                  {s.offerCounts.ACTIVE} active · {s.offerCounts.DRAFT} draft · {s.offerCounts.INACTIVE} inactive · {s.offerCounts.ARCHIVED} archived
                </dd>
              </div>
              <div>
                <dt className="text-xs text-ink-faint">Profile</dt>
                <dd><StatusBadge tone={CONTENT_TONE[s.content.status]}>{CONTENT_LABEL[s.content.status]}</StatusBadge></dd>
              </div>
            </dl>
          </Card>

          {canManage && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Configuration</h2>
              <SellerConfigForm
                sellerId={s.id}
                displayName={s.displayName}
                slug={s.slug}
                supportEmail={s.supportEmail}
                notifyEmail={s.notifyEmail}
                commissionRate={s.commissionRate}
              />
              <p className="mt-3 text-xs text-ink-faint">
                Seller type ({s.type === "FIRST_PARTY" ? "first-party" : "third-party"}) is fixed and not editable here.
              </p>
            </Card>
          )}

          {canManage && (
            <Card>
              <h2 className="mb-3 text-sm font-semibold">Members</h2>
              <SellerUsersPanel sellerId={s.id} users={s.sellerUsers} />
            </Card>
          )}

          <Card padded={false}>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Listings</h2>
              <span className="text-xs text-ink-faint">
                read-only · {listings.length}
                {listings.length === 100 ? "+" : ""}
              </span>
            </div>
            {listings.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-faint">This seller has no catalog listings.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[40rem] border-collapse text-xs">
                  <thead>
                    <tr className="border-b border-line bg-surface-sunken/60 text-[10px] uppercase tracking-wide text-ink-faint">
                      <th className="px-4 py-2 text-left">Product / option</th>
                      <th className="px-4 py-2 text-left">SKU</th>
                      <th className="px-4 py-2 text-left">Condition</th>
                      <th className="px-4 py-2 text-right">Price</th>
                      <th className="px-4 py-2 text-right">Stock</th>
                      <th className="px-4 py-2 text-left">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listings.map((o) => (
                      <tr key={o.id} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-2">
                          <span className="font-medium text-ink">{o.productName}</span>
                          <span className="block text-ink-faint">{o.optionLabel}</span>
                        </td>
                        <td className="px-4 py-2 font-mono text-ink-soft">{o.sellerSku ?? o.variantSku}</td>
                        <td className="px-4 py-2 text-ink-soft">{o.condition}</td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-soft">
                          ₱{(o.price / 100).toLocaleString()}
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums text-ink-soft">{o.available}</td>
                        <td className="px-4 py-2">
                          <StatusBadge tone={o.status === "ACTIVE" ? "success" : o.status === "ARCHIVED" ? "danger" : "neutral"}>
                            {o.status}
                          </StatusBadge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card padded={false}>
            <div className="flex items-center justify-between border-b border-line px-5 py-3">
              <h2 className="text-sm font-semibold">Product requests</h2>
              <span className="text-xs text-ink-faint">read-only · {requests.length}</span>
            </div>
            {requests.length === 0 ? (
              <p className="px-5 py-4 text-sm text-ink-faint">No product requests from this seller.</p>
            ) : (
              <ul className="divide-y divide-line-soft">
                {requests.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{r.name}</span>
                      <span className="block truncate text-xs text-ink-faint">{r.categoryName ?? "no category"}</span>
                    </span>
                    <span className="text-xs text-ink-faint">
                      {r.submittedAt ? new Date(r.submittedAt).toLocaleDateString() : "—"}
                    </span>
                    <StatusBadge
                      tone={
                        r.status === "APPROVED" ? "success" : r.status === "REJECTED" ? "danger" : r.status === "PENDING" ? "info" : "neutral"
                      }
                    >
                      {r.status}
                    </StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

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
                      <span className="capitalize text-ink-soft">{k}:</span> <span className="break-all">{v}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>

          <Card>
            <h2 className="mb-2 text-sm font-semibold">Activity</h2>
            {s.audit.length === 0 ? (
              <p className="text-sm text-ink-faint">No admin activity recorded yet.</p>
            ) : (
              <ul className="space-y-2 text-sm">
                {s.audit.map((a, i) => (
                  <li key={i} className="flex gap-3">
                    <span className="shrink-0 text-xs text-ink-faint">{new Date(a.at).toLocaleString()}</span>
                    <span className="text-ink-soft">{a.summary ?? a.action}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <div className="space-y-4">
          {canManage && (
            <Card>
              <h2 className="mb-2 text-sm font-semibold">Lifecycle</h2>
              <SellerLifecyclePanel
                sellerId={s.id}
                status={s.status}
                allowed={s.allowedTransitions}
              />
            </Card>
          )}

          <Card>
            <h2 className="mb-2 text-sm font-semibold">Content review</h2>
            {!canReviewContent ? (
              <p className="text-sm text-ink-soft">Profile moderation needs the content permission.</p>
            ) : s.content.status === "PENDING" ? (
              <SellerContentReviewPanel sellerId={s.id} />
            ) : (
              <p className="text-sm text-ink-soft">
                {s.content.status === "APPROVED"
                  ? "Profile approved. It returns here for review when the seller next edits it."
                  : "The seller has not submitted a profile for review."}
              </p>
            )}
            {s.content.reviewNote && (
              <div className="mt-3 rounded-sm bg-surface-sunken px-3 py-2 text-xs text-ink-soft">
                <p className="font-medium">
                  Last note{s.content.reviewedByEmail ? ` · ${s.content.reviewedByEmail}` : ""}
                </p>
                <p className="mt-1 whitespace-pre-wrap">{s.content.reviewNote}</p>
              </div>
            )}
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
