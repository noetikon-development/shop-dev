/**
 * PayMongo refund provider-ID fix — tests for the confirmed pre-launch-audit
 * defect: the refund path was passing `Payment.providerId` (the Checkout
 * Session id, `cs_…`) to PayMongo's refund API, which expects the actual
 * Payment resource id (`pay_…`, stored only in `Payment.metadata.providerPaymentId`).
 *
 * `refundRouteForOrder`'s "provider" branch requires `config.mode === "live"`,
 * which is architecturally unreachable outside `NODE_ENV=production` with a
 * genuine `sk_live_` key (a live key hard-disables the feature everywhere
 * else — see `getPaymentsConfig`'s `liveKeyOutsideProd` check). That branch
 * therefore cannot be exercised end-to-end from a test process without either
 * faking Production config (out of scope / unsafe) or genuinely reaching
 * Production. Instead, this file:
 *
 *   A. Unit-tests the pure `extractProviderPaymentId` helper directly (the
 *      exact logic the fix introduces) for correct extraction.
 *   B. Unit-tests the same helper for every "missing/malformed" shape, and
 *      statically confirms `refundRouteForOrder` returns the new "blocked"
 *      route (never substituting `providerId`) when extraction fails.
 *   C–F (existing bookkeeping / seller-attribution / idempotency / caps
 *      behavior unchanged) are covered by re-running the existing
 *      test:9f59 / test:9f60 / test:9f61 suites unmodified — this file does
 *      not duplicate them.
 *
 * No PayMongo API call. No database write outside this file's own read-only
 * checks. No Production data touched.
 *
 *   node --env-file=.env --conditions=react-server --import tsx scripts/test-refund-provider-id.ts
 */
import { readFileSync } from "node:fs";
import { extractProviderPaymentId } from "../src/lib/payments/refund";

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.error(`  FAIL  ${name}   ${detail}`); }
};
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

function unitTests() {
  // ── A · correct extraction ────────────────────────────────────────────
  const metaWithBoth = JSON.stringify({ providerPaymentId: "pay_test_456", other: "x" });
  ok(
    "A · extracts metadata.providerPaymentId (pay_…), never the Checkout Session id",
    extractProviderPaymentId(metaWithBoth) === "pay_test_456",
  );
  ok(
    "A · a Checkout Session id present elsewhere in the row is irrelevant to this function's output",
    extractProviderPaymentId(JSON.stringify({ providerPaymentId: "pay_test_456", providerId: "cs_test_123" })) ===
      "pay_test_456",
  );
  ok(
    "A · trims incidental whitespace",
    extractProviderPaymentId(JSON.stringify({ providerPaymentId: "  pay_test_789  " })) === "pay_test_789",
  );

  // ── B · missing / malformed → null (never a substituted id) ───────────
  ok("B · null metadata → null", extractProviderPaymentId(null) === null);
  ok("B · undefined metadata → null", extractProviderPaymentId(undefined) === null);
  ok("B · empty string metadata → null", extractProviderPaymentId("") === null);
  ok("B · valid JSON with no providerPaymentId key → null", extractProviderPaymentId(JSON.stringify({ order_id: "x" })) === null);
  ok("B · providerPaymentId is not a string → null", extractProviderPaymentId(JSON.stringify({ providerPaymentId: 12345 })) === null);
  ok("B · providerPaymentId is an empty/whitespace string → null", extractProviderPaymentId(JSON.stringify({ providerPaymentId: "   " })) === null);
  ok("B · malformed JSON → null (never throws)", extractProviderPaymentId("{not json") === null);
  ok("B · JSON array (not an object) → null", extractProviderPaymentId("[1,2,3]") === null);
}

function staticTests() {
  const refund = read("src/lib/payments/refund.ts");
  const returnsActions = read("src/lib/admin/returns-actions.ts");
  const sellerActions = read("src/lib/seller/order-actions.ts");
  const sellerRepo = read("src/lib/marketplace/seller-order-repository.ts");

  // ── refund.ts wiring ───────────────────────────────────────────────────
  ok(
    "refund.ts · RefundRoute's provider payload carries providerPaymentId, not providerId",
    /payment: \{ id: string; providerPaymentId: string; amount: number; method: string \| null \}/.test(refund) &&
      !/payment: \{ id: string; providerId: string/.test(refund),
  );
  ok(
    "refund.ts · a new blocked route exists for a missing provider payment id",
    /\| \{ route: "blocked"; code: "MISSING_PROVIDER_PAYMENT_ID"; reason: string \}/.test(refund),
  );
  ok(
    "refund.ts · refundRouteForOrder selects metadata (needed to extract providerPaymentId) instead of providerId",
    /select: \{ id: true, amount: true, method: true, status: true, metadata: true \}/.test(refund) &&
      !/select: \{ id: true, providerId: true, amount: true, method: true, status: true \}/.test(refund),
  );
  ok(
    "refund.ts · a missing/malformed providerPaymentId returns the blocked route BEFORE ever reaching the provider branch, and never falls back to providerId",
    /if \(!providerPaymentId\) \{\s*return \{\s*route: "blocked"/.test(refund) && !/providerId: payment\.providerId/.test(refund),
  );
  ok(
    "refund.ts · the provider route's providerPaymentId comes from the extraction helper, not a raw field read",
    /payment: \{\s*id: payment\.id,\s*providerPaymentId,/.test(refund),
  );

  // ── call sites ─────────────────────────────────────────────────────────
  ok(
    "returns-actions.ts · a blocked route is rejected before ever reaching the provider branch",
    /if \(routing\.route === "blocked"\) \{\s*return \{ ok: false, error: `Refund could not be issued: \$\{routing\.reason\}` \};/.test(
      returnsActions,
    ),
  );
  ok(
    "returns-actions.ts · initiateProviderRefund now receives providerPaymentId, never providerId",
    /providerPaymentId: routing\.payment\.providerPaymentId/.test(returnsActions) &&
      !/providerPaymentId: routing\.payment\.providerId/.test(returnsActions),
  );
  ok(
    "seller/order-actions.ts · callProviderForRefund now receives providerPaymentId, never providerId",
    /callProviderForRefund\(res\.paymentRefundId, routing\.payment\.providerPaymentId\)/.test(sellerActions) &&
      !/routing\.payment\.providerId/.test(sellerActions),
  );
  ok(
    "seller/order-actions.ts · a blocked route is logged (ops-visible) rather than silently dropped or substituting providerId",
    /\} else if \(routing\.route === "blocked"\) \{/.test(sellerActions) &&
      /provider refund blocked — missing PayMongo payment id/.test(sellerActions),
  );

  // ── the DB-only cancellation-transaction call site never used providerId
  //    in the first place (it only reads payment.id) — confirm that remains
  //    true, i.e. this fix did not need to (and did not) touch it.
  ok(
    "seller-order-repository.ts · the in-transaction refund-row step never referenced providerId (unaffected by this fix, confirmed unchanged)",
    /paymentId: routing\.payment\.id,/.test(sellerRepo) && !/routing\.payment\.providerId/.test(sellerRepo),
  );
}

function main() {
  console.log("\nPayMongo refund provider-ID fix — tests\n");
  console.log("Unit tests (extractProviderPaymentId)");
  unitTests();
  console.log("\nStatic wiring (refund.ts + call sites)");
  staticTests();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
