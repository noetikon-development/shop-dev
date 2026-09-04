import type { Metadata } from "next";
import { requireSellerSessionPermission } from "@/lib/seller/session";
import { getSellerSettingsPageData } from "@/lib/seller/settings";
import { PageHeader, Card, StatusBadge } from "@/components/seller/ui";
import { contentStatusLabel, contentStatusTone } from "@/lib/seller/format";
import { ProfileSettingsForm } from "@/components/seller/profile-settings-form";
import { SellerMediaManager } from "@/components/seller/seller-media-manager";
import { ContactSettingsForm } from "@/components/seller/contact-settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SellerSettingsPage() {
  const { ctx } = await requireSellerSessionPermission("manage_seller_settings");
  const data = await getSellerSettingsPageData(ctx);

  if (!data) {
    return (
      <div>
        <PageHeader title="Settings" description="Your seller account could not be loaded." />
      </div>
    );
  }

  const { view, media, mediaCap } = data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Store settings"
        description="Your store profile, logo and policies. Changes are reviewed by Axiaro before they can appear to customers."
        actions={
          <StatusBadge tone={contentStatusTone(view.contentStatus)}>
            {contentStatusLabel(view.contentStatus)}
          </StatusBadge>
        }
      />

      {view.contentStatus === "DRAFT" && view.contentReviewNote && (
        <div className="rounded-sm border border-warning/30 bg-warning-50 px-4 py-3 text-sm text-warning">
          <p className="font-medium">Changes requested by Axiaro</p>
          <p className="mt-1 whitespace-pre-wrap">{view.contentReviewNote}</p>
        </div>
      )}
      {view.contentStatus === "PENDING" && (
        <div className="rounded-sm border border-line bg-surface-sunken px-4 py-3 text-sm text-ink-soft">
          Your profile is in review. You can keep editing — resubmitting replaces what Axiaro sees.
        </div>
      )}

      <Card>
        <h2 className="mb-1 text-sm font-semibold">Store identity</h2>
        <p className="mb-4 text-xs text-ink-faint">
          Your store name and web address are set by Axiaro. Contact us to change them.
        </p>
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-xs text-ink-faint">Store name</dt>
            <dd className="text-sm font-medium">{view.displayName}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-faint">Store address</dt>
            <dd className="text-sm font-medium">/{view.slug}</dd>
          </div>
        </dl>
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold">Logo &amp; banner</h2>
        <SellerMediaManager
          logoUrl={view.logoUrl}
          bannerUrl={view.bannerUrl}
          logoMediaId={view.profile.logoMediaId}
          bannerMediaId={view.profile.bannerMediaId}
          media={media.map((m) => ({
            id: m.id,
            url: m.url,
            filename: m.filename,
            mimeType: m.mimeType,
            width: m.width,
            height: m.height,
          }))}
          count={media.length}
          cap={mediaCap}
        />
      </Card>

      <Card>
        <h2 className="mb-4 text-sm font-semibold">Store profile</h2>
        <ProfileSettingsForm
          bio={view.profile.bio}
          returnPolicy={view.profile.returnPolicy}
          shippingPolicy={view.profile.shippingPolicy}
          shipFromCity={view.profile.shipFromCity}
          shipFromCountry={view.profile.shipFromCountry}
          socialLinks={view.profile.socialLinks}
          contentStatus={view.contentStatus}
        />
      </Card>

      <Card>
        <h2 className="mb-1 text-sm font-semibold">Contact</h2>
        <p className="mb-4 text-xs text-ink-faint">
          Saved immediately — not part of the reviewed profile.
        </p>
        <ContactSettingsForm supportEmail={view.supportEmail} notifyEmail={view.notifyEmail} />
      </Card>
    </div>
  );
}
