import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED_PREFIXES = ["/account", "/wishlist"];

// Admin area. Everything under /admin needs an authenticated session except the
// login page itself. The ROLE check (customer vs admin) can't run here — it
// needs the database — so it lives in src/app/admin/(shell)/layout.tsx, which
// returns a real 403. This block only stops unauthenticated access early.
const ADMIN_PREFIX = "/admin";
const ADMIN_PUBLIC_PATHS = ["/admin/login"];

/**
 * Runs in proxy.ts on every request:
 *  1. Refreshes the Supabase auth session (rotates cookies).
 *  2. Redirects unauthenticated visitors away from customer-only routes and the
 *     admin area.
 * Guest browsing (everything else) is untouched.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() revalidates the token with Supabase — do not replace
  // with getSession() (which only reads the cookie).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  const isProtected = PROTECTED_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
  if (isProtected && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?redirectTo=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  const isAdminArea =
    pathname === ADMIN_PREFIX || pathname.startsWith(`${ADMIN_PREFIX}/`);
  const isAdminPublic = ADMIN_PUBLIC_PATHS.includes(pathname);
  if (isAdminArea && !isAdminPublic && !user) {
    const url = request.nextUrl.clone();
    url.pathname = "/admin/login";
    url.search =
      pathname === ADMIN_PREFIX ? "" : `?redirectTo=${encodeURIComponent(pathname)}`;
    return NextResponse.redirect(url);
  }

  return response;
}
