import type { MetadataRoute } from "next";
import { getSiteUrl } from "@/lib/site-url";
import { getSiteSettings } from "@/lib/site-settings";

// Generated on request so the "allow search indexing" setting takes effect
// without a redeploy.
export const dynamic = "force-dynamic";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const base = getSiteUrl();
  const { seo } = await getSiteSettings();

  if (!seo.indexable) {
    return { rules: { userAgent: "*", disallow: "/" } };
  }

  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/account", "/checkout", "/order", "/api", "/admin"],
    },
    sitemap: `${base}/sitemap.xml`,
  };
}
