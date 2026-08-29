import "server-only";
import { createClient } from "@supabase/supabase-js";

/**
 * Privileged Supabase client (service-role key). BYPASSES RLS and Auth policies.
 * SERVER ONLY — never import into a Client Component. Used sparingly for admin
 * operations that the user's own session cannot perform (e.g. provisioning the
 * demo accounts). Not used in the normal request path.
 */
export function createAdminClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
