import "server-only";
import { getSellerSettings } from "@/lib/marketplace/seller-profile-repository";
import { listSellerMedia, SELLER_MEDIA_CAP } from "@/lib/marketplace/seller-media-repository";
import type { SellerContext, SellerSettingsView } from "@/lib/marketplace/types";

/**
 * Read model for `/seller/settings` (Phase 9F-4a). Composes the profile view and
 * the seller's own media library in one place. Every call is seller-scoped via
 * the repositories — there is no unscoped query here.
 */

export type SellerSettingsPageData = {
  view: SellerSettingsView;
  media: Awaited<ReturnType<typeof listSellerMedia>>;
  mediaCap: number;
};

export async function getSellerSettingsPageData(
  ctx: SellerContext,
): Promise<SellerSettingsPageData | null> {
  const [view, media] = await Promise.all([getSellerSettings(ctx), listSellerMedia(ctx)]);
  if (!view) return null;
  return { view, media, mediaCap: SELLER_MEDIA_CAP };
}
