import "server-only";
import { unstable_cache } from "next/cache";
import { prisma } from "@/lib/prisma";
import {
  SETTING_FIELD_BY_KEY,
  decodeSettingValue,
} from "@/lib/admin/settings-registry";
import { SITE } from "@/lib/constants";

/**
 * Storefront-facing store settings (Step 16). Cached with the `settings` tag so
 * an admin save (which calls `revalidateTag("settings")`) refreshes every page
 * that reads it without a redeploy.
 *
 * Values come from the `StoreSetting` key/value table with the registry defaults
 * filled in. Media ids (logo / favicon / OG image) are resolved to public URLs
 * from `MediaAsset`. URL-typed values are only surfaced when they are a safe
 * `https:` URL — the storefront never renders an unsafe scheme.
 */

export type SiteSettings = {
  name: string;
  brand: string;
  tagline: string;
  description: string;
  status: "open" | "maintenance" | "closed" | string;
  logoUrl: string | null;
  faviconUrl: string | null;
  contact: {
    email: string;
    phone: string;
    addressLine1: string;
    addressLine2: string;
    city: string;
    country: string;
    hours: string;
  };
  business: { legalName: string; registrationNo: string; taxId: string };
  regional: { currency: string; timezone: string; locale: string };
  /** Only safe https links with a non-empty value. */
  social: { label: string; key: string; url: string }[];
  seo: {
    titleTemplate: string;
    defaultTitle: string;
    defaultDescription: string;
    ogImageUrl: string | null;
    indexable: boolean;
  };
};

const SOCIAL_LABELS: Record<string, string> = {
  "social.facebook": "Facebook",
  "social.instagram": "Instagram",
  "social.x": "X",
  "social.tiktok": "TikTok",
  "social.youtube": "YouTube",
};

/** A plain, safe `https://…` URL — no other scheme, no spaces, capped length. */
export function isSafeHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return u.protocol === "https:";
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function fallbackSettings(): SiteSettings {
  return {
    name: SITE.name,
    brand: SITE.brand,
    tagline: SITE.tagline,
    description: SITE.description,
    status: "open",
    logoUrl: null,
    faviconUrl: null,
    contact: { email: "", phone: "", addressLine1: "", addressLine2: "", city: "", country: "", hours: "" },
    business: { legalName: "", registrationNo: "", taxId: "" },
    regional: { currency: "PHP", timezone: "Asia/Manila", locale: "en-PH" },
    social: [],
    seo: {
      titleTemplate: `%s · ${SITE.brand}`,
      defaultTitle: `${SITE.brand} — ${SITE.tagline}`,
      defaultDescription: SITE.description,
      ogImageUrl: null,
      indexable: true,
    },
  };
}

const load = unstable_cache(
  async (): Promise<SiteSettings> => {
    let rows: { key: string; value: string }[];
    try {
      rows = await prisma.storeSetting.findMany({ select: { key: true, value: true } });
    } catch {
      // DB unreachable (e.g. during a build without a database) — safe defaults.
      return fallbackSettings();
    }
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const val = (key: string): unknown => {
      const field = SETTING_FIELD_BY_KEY[key];
      if (!field) return undefined;
      const row = byKey.get(key);
      return row ? decodeSettingValue(row.value, field.type) : field.default;
    };

    // Resolve the media-id settings to public URLs in one query.
    const mediaIds = [val("store.logoMediaId"), val("store.faviconMediaId"), val("seo.ogImageMediaId")]
      .map(str)
      .filter(Boolean);
    const mediaById = new Map<string, string>();
    if (mediaIds.length) {
      try {
        const assets = await prisma.mediaAsset.findMany({
          where: { id: { in: [...new Set(mediaIds)] } },
          select: { id: true, url: true, mimeType: true },
        });
        for (const a of assets) {
          if (a.mimeType.startsWith("image/")) mediaById.set(a.id, a.url);
        }
      } catch {
        /* leave the map empty */
      }
    }
    const mediaUrl = (key: string): string | null => mediaById.get(str(val(key))) ?? null;

    const brand = str(val("store.brand")) || SITE.brand;
    const social = (["social.facebook", "social.instagram", "social.x", "social.tiktok", "social.youtube"] as const)
      .map((key) => ({ key, label: SOCIAL_LABELS[key], url: str(val(key)) }))
      .filter((s) => isSafeHttpsUrl(s.url));

    return {
      name: str(val("store.name")) || SITE.name,
      brand,
      tagline: str(val("store.tagline")) || SITE.tagline,
      description: str(val("store.description")) || SITE.description,
      status: str(val("store.status")) || "open",
      logoUrl: mediaUrl("store.logoMediaId"),
      faviconUrl: mediaUrl("store.faviconMediaId"),
      contact: {
        email: str(val("contact.email")),
        phone: str(val("contact.phone")),
        addressLine1: str(val("contact.addressLine1")),
        addressLine2: str(val("contact.addressLine2")),
        city: str(val("contact.city")),
        country: str(val("contact.country")),
        hours: str(val("contact.hours")),
      },
      business: {
        legalName: str(val("business.legalName")),
        registrationNo: str(val("business.registrationNo")),
        taxId: str(val("business.taxId")),
      },
      regional: {
        currency: str(val("regional.currency")) || "PHP",
        timezone: str(val("regional.timezone")) || "Asia/Manila",
        locale: str(val("regional.locale")) || "en-PH",
      },
      social,
      seo: {
        titleTemplate: str(val("seo.titleTemplate")) || `%s · ${brand}`,
        defaultTitle: str(val("seo.defaultTitle")) || `${brand} — ${str(val("store.tagline")) || SITE.tagline}`,
        defaultDescription: str(val("seo.defaultDescription")) || SITE.description,
        ogImageUrl: mediaUrl("seo.ogImageMediaId"),
        indexable: val("seo.indexable") !== false,
      },
    };
  },
  ["site-settings"],
  { revalidate: 300, tags: ["settings"] },
);

export function getSiteSettings(): Promise<SiteSettings> {
  return load();
}
