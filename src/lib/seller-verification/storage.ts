import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Seller Verification — private storage access foundation (Phase 1).
 *
 * The bucket is a fixed constant, never a caller-supplied value — there is no
 * "arbitrary bucket" this module can be pointed at, by construction. Every
 * document's access goes through a server-issued, short-lived signed URL;
 * this module never calls `getPublicUrl()` and never will for this bucket.
 *
 * `path` must come from a trusted server value (a `SellerVerificationDocument
 * .storagePath` already on file), never a raw browser-supplied string — this
 * module does no authorization of its own. Callers (a future admin review
 * action, a future seller-facing "my documents" view) are responsible for
 * confirming the requester may see the specific document that path belongs
 * to before calling this. No such caller exists yet in this phase — nothing
 * in the application invokes this module, and no route exposes it.
 */

export const SELLER_VERIFICATION_BUCKET = "seller-verification";

/** How long a signed URL stays valid. Kept short — re-request rather than cache. */
const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;

/**
 * Issue a short-lived signed URL for one object in the private Seller
 * Verification bucket. Server-only (import "server-only" above enforces this
 * at build time). Returns null on any storage-side failure rather than
 * throwing — a missing/renamed object is an expected, non-exceptional case
 * for a caller to handle (e.g. show "file unavailable"), not a crash.
 */
export async function getSellerVerificationSignedUrl(
  path: string,
  expiresInSeconds: number = DEFAULT_SIGNED_URL_TTL_SECONDS,
): Promise<string | null> {
  if (!path) return null;
  const supabase = createAdminClient();
  const { data, error } = await supabase.storage
    .from(SELLER_VERIFICATION_BUCKET)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}
