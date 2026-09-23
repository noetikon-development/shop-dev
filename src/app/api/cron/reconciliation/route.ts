import { runReconciliationJob } from "@/lib/marketplace/reconciliation-job";
import { sendReconciliationFailureAlertOps } from "@/lib/email/notifications";

const ROUTE_NAME = "GET /api/cron/reconciliation";

/**
 * Automated reconciliation scheduling/alerting.
 *
 *   Production URL: https://axiaro.shop/api/cron/reconciliation
 *   Schedule:       daily 09:30 UTC (see vercel.json `crons`) — offset from
 *                   the existing seller-order-sla cron at 09:00 UTC.
 *
 * Runs the two active, business-critical reconciliation checks (payments,
 * marketplace — NOT the legacy `reconcile:9e3d`), records one durable
 * AdminAuditLog row per run (PASS included), and sends one deduplicated ops
 * alert email only when the run is WARN or FAIL. See
 * src/lib/marketplace/reconciliation-job.ts for the full behavior.
 *
 * - GET only (Vercel Cron issues GET). POST/others → 405.
 * - Node runtime (Prisma), always dynamic, never cached.
 * - Authenticated by a shared secret, NOT a session — same pattern as
 *   /api/cron/seller-order-sla: Vercel automatically sends
 *   `Authorization: Bearer $CRON_SECRET` on cron invocations when the
 *   `CRON_SECRET` env var is set. Any other caller must present the same
 *   header. Fails CLOSED and inert until an operator sets `CRON_SECRET` in
 *   the Vercel project env: with no secret configured the route returns 503
 *   and does nothing, so deploying this before the env is set changes no
 *   behaviour.
 * - Excluded from the auth middleware (see src/proxy.ts) — same exclusion
 *   pattern already applied to /api/cron/seller-order-sla.
 *
 * This route never writes to an Order / SellerOrder / Payment /
 * PaymentRefund / ReturnRequest / Seller / SellerSettlement / Product /
 * inventory row — only an AdminAuditLog row and, on WARN/FAIL, an EmailLog
 * row for the alert.
 *
 * Hard execution failure (the try below throws before runReconciliationJob
 * returns, so no PASS/WARN/FAIL result and no AdminAuditLog row exist for
 * this run): the catch block still logs to the console AND now also sends a
 * distinct, deduplicated (per calendar day, its own idempotency-key prefix)
 * "reconciliation did not complete" ops alert — see
 * sendReconciliationFailureAlertOps in src/lib/email/notifications.ts. This
 * never replaces or weakens the existing WARN/FAIL alert; it exists only for
 * the case that alert can never cover (the job never got that far). The
 * error is sanitized before it ever leaves this process — see
 * sanitizeReconciliationError.
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
    // Explicit "CRON" — the bearer-token check above is proof this caller is
    // authorized, never proof of what actually triggered the request (a
    // test script or curl call with the correct secret is indistinguishable
    // from Vercel Cron at the HTTP layer), so the source is always supplied
    // explicitly here, not inferred from the auth having succeeded.
    const result = await runReconciliationJob(undefined, "CRON");
    return Response.json({
      ok: true,
      status: result.status,
      runAt: result.runAt,
      payments: { pass: result.payments.pass, warn: result.payments.warn, fail: result.payments.fail },
      marketplace: { pass: result.marketplace.pass, warn: result.marketplace.warn, fail: result.marketplace.fail },
      auditLogId: result.auditLogId,
      alertSent: result.alertSent,
      alertDeduped: result.alertDeduped,
    });
  } catch (err) {
    console.error("[cron] reconciliation failed", err);
    const failedAt = new Date();
    await sendReconciliationFailureAlertOps({
      failedAt,
      dateKey: failedAt.toISOString().slice(0, 10),
      route: ROUTE_NAME,
      error: err,
    });
    return Response.json({ ok: false, error: "reconciliation_failed" }, { status: 500 });
  }
}

export async function POST(): Promise<Response> {
  return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
}
