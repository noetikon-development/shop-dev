/**
 * Lalamove webhook route — "initial connection" check (Phase 9F-48 follow-up).
 *
 * Lalamove's Partner Portal save-time reachability probe sends a POST with no
 * body at all and requires a bare 200 before any signature/complex logic runs
 * (Lalamove's own "Tutorial on Lalamove Webhook" doc, "Receiving the
 * webhooks" #1). This exercises the REAL exported route `POST` handler
 * directly (no HTTP server needed — a Next.js Route Handler is just an async
 * function over the standard `Request`/`Response` Web APIs, both available
 * globally in Node) against three cases: an empty body (must short-circuit to
 * 200 before ever reaching `processShippingWebhook`), a non-empty but
 * unsigned body (must still 401 — proves the empty-body check is not a broad
 * bypass), and a well-formed signed envelope (must still flow through the
 * full real path). No fabricated Lalamove network call — signing here is pure
 * local HMAC, exactly the technique used by test-lalamove-webhook-cascade.ts.
 *
 * The signed-envelope case intentionally targets a `externalShipmentId` that
 * matches no real `Shipment` row — `processShippingWebhook` treats that as a
 * normal, expected case ("no matching Axiaro Shipment... not an error") and
 * returns 200 having written nothing, so this test needs no fixture and
 * leaves no row behind. Uses the real global `prisma` client (read-only
 * lookup only) — nothing to roll back.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-lalamove-webhook-initial-connection.ts
 */
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { POST } from "../src/app/api/webhooks/shipping/[provider]/route";

process.env.SHIPPING_LALAMOVE_API_KEY = "test_key_never_sent";
process.env.SHIPPING_LALAMOVE_API_SECRET = "test_secret_never_sent";
process.env.SHIPPING_LALAMOVE_MODE = "sandbox";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL || process.env.DATABASE_URL });

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};

const URL_ = "https://axiaro.shop/api/webhooks/shipping/lalamove";
const WEBHOOK_PATH = "/api/webhooks/shipping/lalamove";

function call(body: string | undefined) {
  const request = new Request(URL_, {
    method: "POST",
    headers: { "x-forwarded-proto": "https", "Content-Type": "application/json" },
    body,
  });
  return POST(request, { params: Promise.resolve({ provider: "lalamove" }) });
}

/** Self-signs a Lalamove ORDER_STATUS_CHANGED envelope — pure local HMAC, no network call. */
function mkSignedEnvelope(externalShipmentId: string): string {
  const data = { order: { orderId: externalShipmentId, status: "ASSIGNING_DRIVER" }, updatedAt: new Date().toISOString() };
  const timestamp = Date.now();
  const toSign = `${timestamp}\r\nPOST\r\n${WEBHOOK_PATH}\r\n\r\n${JSON.stringify(data)}`;
  const signature = crypto.createHmac("sha256", process.env.SHIPPING_LALAMOVE_API_SECRET!).update(toSign).digest("hex");
  return JSON.stringify({
    apiKey: process.env.SHIPPING_LALAMOVE_API_KEY, timestamp, signature,
    eventId: crypto.randomUUID(), eventType: "ORDER_STATUS_CHANGED", eventVersion: "v3", data,
  });
}

async function main() {
  console.log("\nLalamove webhook route — initial connection check\n");

  const before = await prisma.shipmentEvent.count();

  // ── Test 1: empty/bodyless POST → 200, before any signature logic ────────
  const emptyRes = await call("");
  ok("1 · empty body → HTTP 200", emptyRes.status === 200, `got ${emptyRes.status}`);
  ok("1 · empty body → body is a bare ack, not the normal 'ok' JSON path's shape mistaken for a real event", (await emptyRes.text()) === "ok");

  // Also cover `undefined` body (no body set at all on the Request, distinct
  // from an explicit zero-length string) — same code path, same result.
  const noBodyRes = await call(undefined);
  ok("1b · no body at all (undefined) → HTTP 200", noBodyRes.status === 200, `got ${noBodyRes.status}`);

  // ── Test 2: non-empty, unsigned/invalid body → still 401 "invalid signature" ──
  const invalidRes = await call("{}");
  ok("2 · non-empty unsigned body → HTTP 401", invalidRes.status === 401, `got ${invalidRes.status}`);
  ok("2 · non-empty unsigned body → 'invalid signature'", (await invalidRes.text()) === "invalid signature");

  const garbageRes = await call("not even json");
  ok("2b · non-empty garbage (not JSON) body → still HTTP 401, not fabricated success", garbageRes.status === 401);

  // ── Test 3: a well-formed, correctly signed envelope still flows through the
  //    REAL verify → parse → lookup path (proves the empty-body check does not
  //    shadow or weaken real signature verification) ──────────────────────
  const signedRes = await call(mkSignedEnvelope(`NO-SUCH-SHIPMENT-${crypto.randomUUID()}`));
  ok("3 · well-formed signed envelope → HTTP 200 (passes verification, no matching Shipment, still acknowledged)", signedRes.status === 200, `got ${signedRes.status}`);
  ok("3 · well-formed signed envelope is NOT rejected as 'invalid signature' — proves real HMAC verification actually ran (distinct outcome from Test 2)", (await signedRes.text()) !== "invalid signature");

  const after = await prisma.shipmentEvent.count();
  ok("3b · no ShipmentEvent row created — the signed envelope targeted no real Shipment, exactly like production would for an unmatched event", after === before, `before=${before} after=${after}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  await prisma.$disconnect();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
