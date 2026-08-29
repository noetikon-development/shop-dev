import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import {
  SETTINGS_REGISTRY,
  SETTING_GROUPS,
  getStoreSettings,
  type SettingGroupKey,
} from "@/lib/admin/settings";
import { PageHeader, Card, StatusBadge } from "@/components/admin/ui";

export const metadata: Metadata = { title: "Settings" };

function render(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export default async function AdminSettingsPage() {
  const admin = await requirePermission("view_settings");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_settings");
  const values = await getStoreSettings();

  const groups = Object.keys(SETTING_GROUPS) as SettingGroupKey[];

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Store identity, contact, regional and integration configuration. Every value is data — no business-specific values are hardcoded in the app."
        actions={
          <StatusBadge tone={canManage ? "info" : "neutral"}>
            {canManage ? "Editing arrives in a later step" : "Read-only (needs manage_settings)"}
          </StatusBadge>
        }
      />

      <div className="space-y-5">
        {groups.map((groupKey) => {
          const group = SETTING_GROUPS[groupKey];
          const fields = SETTINGS_REGISTRY.filter((f) => f.group === groupKey);
          if (fields.length === 0) return null;
          return (
            <Card key={groupKey}>
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-ink">{group.label}</h2>
                <p className="text-xs text-ink-faint">{group.description}</p>
              </div>
              <dl className="divide-y divide-line">
                {fields.map((field) => (
                  <div
                    key={field.key}
                    className="grid grid-cols-1 gap-1 py-2.5 sm:grid-cols-[220px_1fr] sm:gap-4"
                  >
                    <dt className="text-sm text-ink-soft">
                      {field.label}
                      <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">
                        {field.type}
                      </span>
                    </dt>
                    <dd className="min-w-0 break-words text-sm text-ink">
                      {render(values[field.key])}
                      {field.help && (
                        <span className="mt-0.5 block text-xs text-ink-faint">{field.help}</span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
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
