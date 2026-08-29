import { NextResponse } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { syncAppUser } from "@/lib/auth";
import { claimAdminInvites } from "@/lib/admin/provisioning";

/**
 * Landing point for every Supabase email link (email verification + password
 * recovery). Handles both link formats:
 *   - PKCE:      ?code=...
 *   - token/OTP: ?token_hash=...&type=signup|recovery|email
 * On success we exchange for a cookie session, provision the app User, then send
 * the visitor to `next`.
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const next = sanitizeNext(searchParams.get("next"));
  const supabase = await createClient();

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;

  let userId: string | undefined;
  let ok = false;

  if (code) {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    ok = !error;
    userId = data.user?.id;
  } else if (tokenHash && type) {
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    ok = !error;
    userId = data.user?.id;
  }

  if (ok) {
    if (userId) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        try {
          const appUser = await syncAppUser(user);
          // Apply any pending admin invitation for this address (e.g. arriving
          // via a Supabase invite email). Idempotent and safe for customers.
          await claimAdminInvites(appUser, user.email ?? appUser.email);
        } catch {
          /* provisioned on next authenticated request */
        }
      }
    }
    return NextResponse.redirect(`${origin}${next}`);
  }

  return NextResponse.redirect(
    `${origin}/login?error=${encodeURIComponent("That link is invalid or has expired.")}`,
  );
}

function sanitizeNext(next: string | null): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) return "/account";
  return next;
}
