import { runSellerOrderAcceptanceSla } from "@/lib/marketplace/seller-order-sla-job";

/**
 * 3P seller-order acceptance SLA sweep (Phase 9F-32A).
 *
 *   Production URL: https://axiaro.shop/api/cron/seller-order-sla
 *   Schedule:       daily 09:00 UTC (see vercel.json `crons`). The Vercel Hobby
 *                   plan caps crons at once/day; for finer cadence (the SLA
 *                   thresholds are 4h / 24h) either upgrade to Pro and set the
 *                   schedule to `0 * * * *`, or point any external scheduler at
 *                   this URL with `Authorization: Bearer $CRON_SECRET`. The sweep
 *                   is idempotent, so running it more often is harmless.
 *
 * - GET only (Vercel Cron issues GET). POST/others → 405.
 * - Node runtime (Prisma), always dynamic, never cached.
 * - Authenticated by a shared secret, NOT a session: Vercel automatically sends
 *   `Authorization: Bearer $CRON_SECRET` on cron invocations when the
 *   `CRON_SECRET` env var is set. Any other caller must present the same header.
 * - Fails CLOSED and inert until an operator sets `CRON_SECRET` in the Vercel
 *   project env: with no secret configured the route returns 503 and does
 *   nothing, so deploying this before the env is set changes no behaviour.
 * - Excluded from the auth middleware (see src/proxy.ts).
 *
 * The sweep itself never writes to an order / SellerOrder / inventory row — it
 * reads, writes at most one `seller_order.acceptance_overdue` audit row per
 * SellerOrder, and schedules idempotent notification emails.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) {
    return Response.json(
      { ok: false, error: "cron_not_configured" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }

  try {
    const result = await runSellerOrderAcceptanceSla();
    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron] seller-order-sla failed", err);
    return Response.json({ ok: false, error: "sweep_failed" }, { status: 500 });
  }
}

export async function POST(): Promise<Response> {
  return new Response("method not allowed", { status: 405, headers: { Allow: "GET" } });
}
