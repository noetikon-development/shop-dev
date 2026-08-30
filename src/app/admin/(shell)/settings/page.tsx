import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import {
  SETTINGS_REGISTRY,
  SETTING_GROUPS,
  getStoreSettings,
  type SettingGroupKey,
} from "@/lib/admin/settings";
import { getPickerAssets } from "@/lib/admin/media-picker-data";
import { PageHeader, StatusBadge } from "@/components/admin/ui";
import { SettingsGroupForm } from "@/components/admin/settings/settings-group-form";

export const metadata: Metadata = { title: "Settings" };

export default async function AdminSettingsPage() {
  const admin = await requirePermission("view_settings");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_settings");
  const [values, mediaAssets] = await Promise.all([getStoreSettings(), getPickerAssets()]);

  const groups = Object.keys(SETTING_GROUPS) as SettingGroupKey[];

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Store identity, contact, branding, regional and SEO configuration. Every value is data — nothing business-specific is hardcoded. Changes appear on the storefront within a minute (no redeploy)."
        actions={
          <StatusBadge tone={canManage ? "success" : "neutral"}>
            {canManage ? "Editable" : "Read-only (needs manage_settings)"}
          </StatusBadge>
        }
      />

      <div className="space-y-5">
        {groups.map((groupKey) => {
          const group = SETTING_GROUPS[groupKey];
          const fields = SETTINGS_REGISTRY.filter((f) => f.group === groupKey);
          if (fields.length === 0) return null;
          return (
            <SettingsGroupForm
              key={groupKey}
              groupKey={groupKey}
              groupLabel={group.label}
              groupDescription={group.description}
              fields={fields}
              values={values}
              canManage={canManage}
              mediaAssets={mediaAssets}
            />
          );
        })}
      </div>

      <p className="mt-5 text-xs text-ink-faint">
        Sensitive integration credentials (payment API keys, SMTP passwords) are
        never stored here or sent to the browser — they live in server-side
        environment variables only.
      </p>
    </div>
  );
}
