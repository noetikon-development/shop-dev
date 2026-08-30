"use server";

import { revalidatePath, revalidateTag } from "next/cache";
import { prisma } from "@/lib/prisma";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import {
  SETTINGS_REGISTRY,
  SETTING_FIELD_BY_KEY,
  SETTING_GROUPS,
  encodeSettingValue,
  type SettingField,
  type SettingGroupKey,
} from "@/lib/admin/settings-registry";
import { isSafeHttpsUrl } from "@/lib/site-settings";
import { cleanUserText } from "@/lib/ugc";

/**
 * Store settings writes (Step 16). Requires `manage_settings` — an ADMIN who
 * only holds `view_settings` cannot save (the RBAC catalogue deliberately keeps
 * these apart, and the check is server-side).
 *
 * Only keys that exist in the settings registry are ever written; anything else
 * in the payload is ignored. Every value is validated by its declared type
 * before it touches the database, so malformed input can't break the storefront.
 */

export type SettingsActionState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: Record<string, string>;
  savedGroup?: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(field: SettingField, raw: string): { value: unknown } | { error: string } {
  const v = raw.trim();
  switch (field.type) {
    case "boolean":
      return { value: v === "true" || v === "on" || v === "1" };
    case "number": {
      if (v === "") return { value: field.default ?? 0 };
      const n = Number(v);
      if (!Number.isFinite(n)) return { error: "Enter a number." };
      if (n < 0) return { error: "Must be zero or more." };
      if (n > 1_000_000_000) return { error: "That's too large." };
      return { value: Math.round(n) };
    }
    case "email":
      if (v === "") return { value: "" };
      if (v.length > 254 || !EMAIL_RE.test(v)) return { error: "Enter a valid email address." };
      return { value: v.toLowerCase() };
    case "url":
      if (v === "") return { value: "" };
      if (!isSafeHttpsUrl(v)) return { error: "Enter a full https:// URL." };
      return { value: v };
    case "media":
      // Empty clears it. Otherwise it must be an id shape; existence is checked
      // by the caller in one batched query.
      if (v === "") return { value: "" };
      if (!/^[a-z0-9]{20,40}$/i.test(v)) return { error: "Pick an image from the media library." };
      return { value: v };
    case "json":
      // JSON settings are not editable through this form (they are configured in
      // dedicated screens — shipping, payments). Ignore any submitted value.
      return { error: "__skip__" };
    case "text":
    case "string":
    default: {
      const cleaned = cleanUserText(v);
      const max = field.type === "text" ? 4000 : 300;
      if (cleaned.length > max) return { error: `Keep this under ${max} characters.` };
      return { value: cleaned };
    }
  }
}

export async function updateSettingsAction(
  _prev: SettingsActionState,
  formData: FormData,
): Promise<SettingsActionState> {
  const admin = await requirePermission("manage_settings");

  const group = String(formData.get("__group") ?? "") as SettingGroupKey;
  if (!(group in SETTING_GROUPS)) return { ok: false, error: "Unknown settings group." };

  const groupFields = SETTINGS_REGISTRY.filter((f) => f.group === group && f.type !== "json");

  const fieldErrors: Record<string, string> = {};
  const updates: { key: string; value: string; type: string }[] = [];
  const mediaIdsToCheck: string[] = [];

  for (const field of groupFields) {
    // Booleans: an absent checkbox means false.
    const raw =
      field.type === "boolean"
        ? formData.has(field.key)
          ? "true"
          : "false"
        : String(formData.get(field.key) ?? "");
    if (field.type !== "boolean" && !formData.has(field.key)) continue; // not on this form

    const res = validate(field, raw);
    if ("error" in res) {
      if (res.error !== "__skip__") fieldErrors[field.key] = res.error;
      continue;
    }
    if (field.type === "media" && typeof res.value === "string" && res.value) {
      mediaIdsToCheck.push(res.value);
    }
    updates.push({ key: field.key, value: encodeSettingValue(res.value, field.type), type: field.type });
  }

  // Verify every referenced media id actually exists and is an image.
  if (mediaIdsToCheck.length) {
    const found = await prisma.mediaAsset.findMany({
      where: { id: { in: [...new Set(mediaIdsToCheck)] } },
      select: { id: true, mimeType: true },
    });
    const ok = new Set(found.filter((m) => m.mimeType.startsWith("image/")).map((m) => m.id));
    for (const u of updates) {
      if (u.type === "media" && u.value && !ok.has(u.value)) {
        fieldErrors[u.key] = "That image is no longer in the media library.";
      }
    }
  }

  if (Object.keys(fieldErrors).length) {
    return { ok: false, error: "Please fix the highlighted fields.", fieldErrors };
  }

  const changed: string[] = [];
  await prisma.$transaction(
    updates.map((u) => {
      const field = SETTING_FIELD_BY_KEY[u.key];
      changed.push(u.key);
      return prisma.storeSetting.upsert({
        where: { key: u.key },
        create: {
          key: u.key,
          value: u.value,
          type: field.type,
          label: field.label,
          group: `settings:${field.group}`,
        },
        update: { value: u.value },
      });
    }),
  );

  await writeAudit({
    actorUserId: admin.user.id,
    action: "settings.updated",
    targetType: "settings",
    targetId: group,
    summary: `${admin.user.email} updated ${SETTING_GROUPS[group].label.toLowerCase()} settings`,
    meta: { group, keys: changed },
  });

  revalidateTag("settings", "max");
  revalidatePath("/", "layout");
  revalidatePath("/admin/settings");

  return { ok: true, savedGroup: group };
}
