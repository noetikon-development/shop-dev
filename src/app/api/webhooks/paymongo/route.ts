import { processPaymongoWebhook } from "@/lib/payments/webhook";

/**
 * PayMongo webhook endpoint (Step 21 P4).
 *
 *   Production URL: https://axiaro.shop/api/webhooks/paymongo
 *
 * - POST only. GET/others → 405.
 * - Node runtime (needs node:crypto + Prisma), always dynamic, never cached.
 * - Excluded from the auth middleware (see src/proxy.ts) — it is authenticated
 *   by HMAC signature, not by a session.
 * - The raw request body is read verbatim and handed to
 *   `processPaymongoWebhook`, which verifies the signature BEFORE any parse or
 *   DB write. This route never logs the body, the signature header, or any
 *   secret.
 *
 * Phase 4-A: no webhook secret is configured in production, so every real
 * request is rejected 401 (signature fails closed). The endpoint is otherwise
 * inert.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const isHttps =
    request.headers.get("x-forwarded-proto") === "https" ||
    new URL(request.url).protocol === "https:";

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Cap the body size — a legitimate PayMongo event is a few KB.
  if (rawBody.length > 512 * 1024) {
    return new Response("payload too large", { status: 413 });
  }

  const result = await processPaymongoWebhook(rawBody, request.headers.get("paymongo-signature"), {
    isHttps,
  });

  return new Response(result.body, {
    status: result.status,
    headers: { "Content-Type": "text/plain" },
  });
}

export async function GET(): Promise<Response> {
  return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
}
