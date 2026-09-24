import { runReconciliationWatchdog } from "@/lib/marketplace/reconciliation-watchdog";

/**
 * Reconciliation stale-run watchdog.
 *
 *   Production URL: https://axiaro.shop/api/cron/reconciliation-watchdog
 *   Schedule:       hourly, 0 * * * * (see vercel.json `crons`) — independent
 *                   of the daily 09:30 UTC reconciliation cron itself.
 *
 * Finds CRON-invoked `ReconciliationRun` rows still `RUNNING` more than 30
 * minutes after they started (the process almost certainly died before
 * either the job's own or this route's sibling `/api/cron/reconciliation`
 * catch block could run), marks each ERROR via a guarded update, writes one
 * `AdminAuditLog` row, and sends one deduplicated ops alert per run. See
 * src/lib/marketplace/reconciliation-watchdog.ts and docs/reconciliation.md
 * for the full behavior.
 *
 * - GET only (Vercel Cron issues GET). POST/others → 405.
 * - Node runtime (Prisma), always dynamic, never cached.
 * - Authenticated by the same shared secret as the existing reconciliation
 *   cron: Vercel automatically sends `Authorization: Bearer $CRON_SECRET` on
 *   cron invocations when the `CRON_SECRET` env var is set. Any other caller
 *   must present the same header. Fails CLOSED and inert until an operator
 *   sets `CRON_SECRET`: with no secret configured the route returns 503 and
 *   does nothing.
 * - Excluded from the auth middleware (see src/proxy.ts) by the existing,
 *   already-general `api/cron` prefix exclusion — no proxy change was needed
 *   for this route.
 *
 * This route never writes to an Order / SellerOrder / Payment /
 * PaymentRefund / ReturnRequest / Seller / SellerSettlement / Product /
 * inventory row, and never calls PayMongo, Lalamove, or any other provider —
 * only a guarded `ReconciliationRun` transition, an `AdminAuditLog` row, and
 * (only when a stale run is found) an `EmailLog` row for the alert.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return Response.json({ ok: false, error: "cron_not_configured" }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const result = await runReconciliationWatchdog();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] reconciliation watchdog failed", err);
    return Response.json({ ok: false, error: "watchdog_failed" }, { status: 500 });
  }
}

export async function POST(): Promise<Response> {
  return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
}
