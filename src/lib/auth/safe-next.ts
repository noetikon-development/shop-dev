/**
 * Password-recovery return path — a strict ALLOW-LIST, not a sanitiser.
 *
 * The forgot / reset flow can be entered from the customer sign-in page or the
 * seller sign-in page. `next` only ever needs to name one of those two, so we
 * allow-list exactly them and fall back to the customer default. This makes an
 * open redirect impossible regardless of how the value reaches us (query param,
 * hidden form field, or nested inside the Supabase `redirectTo`).
 */

const ALLOWED = new Set(["/login", "/seller/login"]);
export const DEFAULT_AUTH_NEXT = "/login";

export function safeAuthNext(raw: string | null | undefined): string {
  if (typeof raw !== "string") return DEFAULT_AUTH_NEXT;
  return ALLOWED.has(raw) ? raw : DEFAULT_AUTH_NEXT;
}
