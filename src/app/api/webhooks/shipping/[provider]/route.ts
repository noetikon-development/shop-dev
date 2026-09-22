import { processShippingWebhook } from "@/lib/shipping/webhook";

/**
 * Provider-agnostic carrier webhook endpoint (Phase 9F-48).
 *
 *   Production URL shape: https://axiaro.shop/api/webhooks/shipping/lalamove
 *
 * - POST only. GET/others → 405.
 * - Node runtime (needs node:crypto + Prisma), always dynamic, never cached.
 * - Authenticated by the resolved provider's own `verifyWebhook` (for
 *   Lalamove: a signature embedded in the JSON body, not a header — see
 *   `src/lib/shipping/providers/lalamove.ts`), not by a session.
 * - The raw body is read verbatim and handed to `processShippingWebhook`
 *   together with the `[provider]` path segment; this route never logs the
 *   body or any secret.
 * - Dormant by design: no `Shipment.provider = "LALAMOVE"` row exists in
 *   Production (the registry fails closed to MANUAL — see `registry.ts`),
 *   so even a genuine, correctly-signed Lalamove webhook finds no matching
 *   Shipment and is acknowledged with 200 and no further effect.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }): Promise<Response> {
  const { provider } = await params;

  const isHttps =
    request.headers.get("x-forwarded-proto") === "https" || new URL(request.url).protocol === "https:";

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Cap the body size — a legitimate carrier event is a few KB.
  if (rawBody.length > 512 * 1024) {
    return new Response("payload too large", { status: 413 });
  }

  const result = await processShippingWebhook(provider, rawBody, { isHttps });

  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function GET(): Promise<Response> {
  return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
}
