import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    /*
     * Everything except Next internals, static files, and provider webhooks.
     * Keeps the auth session fresh on every navigable route without touching
     * asset requests. `api/webhooks/*` is excluded: those endpoints are
     * authenticated by signature, not by a session, and must not incur a
     * Supabase round-trip or cookie handling.
     */
    "/((?!_next/static|_next/image|api/webhooks|favicon.ico|icon.png|apple-icon|robots.txt|sitemap.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
