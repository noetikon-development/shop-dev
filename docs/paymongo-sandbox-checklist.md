# Axiaro PayMongo TEST/Sandbox Validation Checklist

**TEST/Sandbox ONLY.** Every scenario in this document is executed against
the **Preview** environment using PayMongo **TEST** credentials only.

- No Production credentials.
- No Production payment.
- No Production refund.
- No Production webhook.
- No Production business data is created, modified, or used as a fixture.

This checklist exists because the PayMongo pre-launch audit
(2026-09-21) found no formal sandbox validation procedure in the
repository. It defines the fixed procedure; it does not itself run any
scenario. No result below may be marked `PASS` by writing this document —
every row starts `NOT RUN` and is only updated by someone who actually
executed that scenario.

## Important limitation — read before running anything

**TEST credential identity and TEST webhook registration are NOT verified
by this document.** A prior audit could not confirm, from this
environment, that Preview's `PAYMONGO_SECRET_KEY` is genuinely a
`sk_test_…` key (Vercel's CLI shows secret-type environment variables as
`Hidden` with no prefix preview) or that a PayMongo TEST webhook is
actually registered and pointed at the Preview endpoint — both require
either the PayMongo dashboard or an authenticated admin session on
Preview (the `/admin/payments` diagnostics panel exposes
`detectedMode`/`configuredMode` safely, with no secret value). **Both
must be independently confirmed through the PayMongo dashboard or
another authoritative PayMongo source before any scenario below is
executed.** Do not proceed on the assumption that they already are.

## Architecture context (verified from source, 2026-09-21)

- `Payment.providerId` = the PayMongo **Checkout Session ID** (`cs_xxx`) —
  set once at session creation (`src/lib/payments/checkout-session.ts`,
  `beginOnlinePayment`), never updated afterward.
- `Payment.metadata.providerPaymentId` = the actual PayMongo **Payment
  ID** (`pay_xxx`) — set only by the webhook's `applyPaid` handler
  (`src/lib/payments/webhook.ts`) once a `*.paid` event confirms the
  capture.
- A provider-routed refund (`src/lib/payments/refund.ts`,
  `refundRouteForOrder`) requires `config.mode === "live"`. Following the
  2026-09-21 activation-safety hardening, `mode === "live"` can only be
  reached together with a non-mismatched key in genuine Vercel Production
  (`VERCEL_ENV === "production"`) — a live key on Preview is now
  explicitly blocked, and a live `mode` setting with a test key (or vice
  versa) was already blocked before that. **Consequence: initiating a
  real PayMongo refund API call cannot be exercised in Preview under any
  TEST configuration — this is by design, not a gap in this checklist.**
  Scenarios 9–13 below split each refund scenario into the DB-only half
  (testable in Preview) and the provider-call half (architecturally
  blocked in Preview), and mark each half separately.
- The webhook route (`/api/webhooks/paymongo`) handles exactly five event
  types (`src/lib/payments/status.ts`, `isHandledWebhookType`):
  `checkout_session.payment.paid`, `payment.paid`, `payment.failed`,
  `checkout_session.expired`, `refund.updated`. Any other type is
  acknowledged and marked `IGNORED` (200), never treated as an error.

---

## Pre-test checklist (mandatory, before running any scenario)

- [ ] Confirm environment = Preview (the deployment under test is a
      Preview deployment, not `axiaro.shop`).
- [ ] Confirm PayMongo credentials configured for Preview are TEST
      credentials — **via the PayMongo dashboard or `/admin/payments`
      diagnostics on Preview**, not assumed.
- [ ] Confirm a TEST webhook is registered in the PayMongo dashboard and
      points at the Preview deployment's `/api/webhooks/paymongo` URL.
- [ ] Confirm no Production `PAYMONGO_*` environment variables exist
      (`vercel env ls production` — names only, never values).
- [ ] Confirm Production `StoreSetting` rows (`payments.*`) have not been
      changed as part of test setup.
- [ ] Confirm no Production business data (real orders, customers,
      sellers) will be used as a fixture for any scenario.
- [ ] Confirm no PayMongo **Live** credentials are present anywhere in
      Preview's environment variables.

## Post-test checklist (mandatory, after running any scenario)

- [ ] Remove/clean up TEST fixtures created for the scenario (test
      orders, test Payment/PaymentRefund rows) where the scenario's own
      "Cleanup requirements" call for it.
- [ ] Confirm Production business-data counts are unchanged from the
      baseline recorded before testing began.
- [ ] Confirm no Production PayMongo API call occurred (Production has no
      `PAYMONGO_*` variables, so this should be structurally impossible —
      confirm it stayed that way).
- [ ] Confirm Preview remains isolated (no data or state leaked back into
      Production; Preview and Production share one database, so this
      means confirming no *Preview-created* fixture rows were left in a
      state that could be mistaken for Production data).
- [ ] Record final results in the summary table at the end of this
      document.

---

## Scenario 1 — Successful card payment

- **Objective**: confirm a card checkout session, when paid, correctly
  transitions `Payment`/`Order` to PAID via the webhook.
- **Preconditions**: Preview deployment live; TEST credentials confirmed
  (see pre-test checklist); `payments.onlinePaymentEnabled=true`,
  `payments.mode` resolving to `test`; `CARD` in `payments.enabledMethods`.
- **Test environment**: Preview only.
- **Test data requirements**: one test customer account (or guest
  checkout) on Preview; one order in `PENDING_PAYMENT` created via the
  normal checkout flow.
- **Exact steps**:
  1. Add an item to cart, check out with a First-Party product (3P online
     payment is not implemented).
  2. Reach the PayMongo hosted Checkout Session (`beginOnlinePayment`
     redirect).
  3. Complete payment using a PayMongo TEST card test number.
  4. Wait for the redirect back to `/order/[orderNumber]?pay=return` and
     for the webhook to arrive.
- **Expected result**: `Order.status` → `PAID` then (unless
  `payments.holdForReview`) → `PROCESSING`; `Order.paymentStatus` →
  `PAID`; `Payment.status` → `PAID`.
- **Database records to inspect**: `Payment` (`status=PAID`, `paidAt`
  set, `method` populated, `metadata.providerPaymentId` now present —
  see the Payment Identity scenario below); `Order`
  (`status`/`paymentStatus`); `OrderEvent` (`PAID`, and `PROCESSING` if
  not held for review); `WebhookEvent` (`status=PROCESSED`).
- **Email/timeline result**: `sendPaymentConfirmation` scheduled;
  customer-facing order timeline shows "Payment received".
- **Pass criteria**: all of the above match exactly; no duplicate
  `OrderEvent` rows; amount/currency matched the order snapshot (the
  handler throws otherwise — see `applyPaid`'s amount/currency guard).
- **Failure criteria**: `Order`/`Payment` status does not advance, an
  amount/currency mismatch is thrown, or no `WebhookEvent` row is
  created.
- **Cleanup requirements**: none required for a rows-based Preview test
  fixture beyond normal test hygiene; do not attempt to delete the
  PayMongo-side test object (not necessary, TEST mode has no real money).

## Scenario 2 — Successful GCash payment

Identical structure to Scenario 1, using a GCash TEST flow.

- **Objective**: confirm the `source.type`-derived `method` resolves
  correctly and the same PAID transition occurs for a non-card method.
- **Preconditions/Test environment/Test data**: same as Scenario 1, with
  `GCASH` in `payments.enabledMethods`.
- **Exact steps**: same as Scenario 1, selecting GCash at the PayMongo
  hosted checkout and completing via PayMongo's GCash TEST simulator.
- **Expected result**: same as Scenario 1; `Payment.method` reflects
  `gcash` (via `orderPaymentMethodFromProvider`).
- **Database records to inspect**: same as Scenario 1.
- **Email/timeline result**: same as Scenario 1.
- **Pass/Failure criteria**: same as Scenario 1.
- **Cleanup requirements**: same as Scenario 1.

## Scenario 3 — Payment-session lifecycle

- **Objective**: confirm session creation, resumption, and cancellation
  behave as implemented (`beginOnlinePayment`, `canResumeOnlinePayment`).
- **Preconditions**: as Scenario 1.
- **Test environment**: Preview only.
- **Test data requirements**: one order in `PENDING_PAYMENT`.
- **Exact steps**:
  1. Start checkout, reach the hosted session, then abandon it (close the
     tab) without paying.
  2. Return to the order page and use "Pay now" again — confirm the
     **same** `checkoutUrl` is returned (`resumed: true`, no second
     PayMongo API call) rather than a new session.
  3. This time, click PayMongo's own "Cancel"/back option, landing on
     `/order/[orderNumber]?pay=cancelled`.
  4. Confirm the order is still resumable afterward.
- **Expected result**: step 2 resumes the existing `AWAITING_PAYMENT`
  `Payment` row without creating a second one (the partial unique index
  `payment_one_active_per_order` is the concurrency guard); step 3
  returns to the order page with no Payment/Order status change (a
  client-side cancel is not itself a webhook event).
- **Database records to inspect**: `Payment` — exactly one row for this
  order stays `AWAITING_PAYMENT` throughout; confirm no duplicate
  `Payment` rows were created by the resume.
- **Pass criteria**: resume returns `resumed: true` and the identical
  `checkoutUrl`; no duplicate `Payment` row exists at any point.
- **Failure criteria**: a second `Payment` row is created for the same
  order, or resume triggers a new PayMongo API call (observable via a
  changed `checkoutUrl`).
- **Cleanup requirements**: none beyond normal fixture hygiene.

## Scenario 4 — Webhook signature verification

- **Objective**: confirm signature verification runs before any parse,
  DB write, or logging, and rejects a bad signature.
- **Preconditions**: `PAYMONGO_WEBHOOK_SECRET` present on Preview.
- **Test environment**: Preview only. **Do not send this to Production.**
- **Test data requirements**: a captured or synthetic PayMongo webhook
  payload; a deliberately invalid/tampered signature header.
- **Exact steps**:
  1. Send a POST to Preview's `/api/webhooks/paymongo` with a valid-shape
     payload but an invalid `Paymongo-Signature` header.
  2. Separately, send the same payload with **no** signature header.
- **Expected result**: both return `401` with body `"signature
  verification failed"`; no `WebhookEvent` row is created (signature
  check runs before the event-id claim); the failure reason is logged
  server-side only (`console.warn`), never the raw body or header.
- **Database records to inspect**: confirm no new `WebhookEvent` row
  exists for either attempt.
- **Pass criteria**: `401` in both cases, no database row created.
- **Failure criteria**: any status other than `401`, or a `WebhookEvent`
  row created for an unverified payload.
- **Cleanup requirements**: none (no row is created on success of this
  test).

## Scenario 5 — Duplicate webhook delivery / idempotency

- **Objective**: confirm redelivery of the same event id is a safe no-op.
- **Preconditions**: a genuine TEST `*.paid` event already processed
  (e.g., from Scenario 1).
- **Test environment**: Preview only.
- **Exact steps**: resend (or have PayMongo's own retry redeliver) the
  identical event id.
- **Expected result**: `200` with body `"duplicate — already
  processed"`; no second `OrderEvent`/`AdminAuditLog`/state change. If
  the payload hash differs from the first delivery for the same event
  id, a `console.warn` tamper signal is logged (still `200`).
- **Database records to inspect**: `WebhookEvent` — exactly one row for
  this `providerId`; `OrderEvent` — no duplicate row for the same
  transition.
- **Pass criteria**: exactly one `WebhookEvent` row survives; no
  duplicate state-changing side effect.
- **Failure criteria**: a second `OrderEvent`/audit row, or a changed
  `Order`/`Payment` status from the redelivery.
- **Cleanup requirements**: none.

## Scenario 6 — Unhandled webhook event type

- **Objective**: confirm a webhook event type this app doesn't process is
  acknowledged, not treated as an error.
- **Preconditions**: none beyond a working webhook endpoint.
- **Test environment**: Preview only.
- **Exact steps**: send a validly-signed webhook payload whose
  `data.attributes.type` is not one of the five handled types (e.g. a
  type PayMongo emits that this app doesn't currently act on).
- **Expected result**: `200` with body `"ignored (unhandled type)"`;
  `WebhookEvent.status = "IGNORED"`, `error = "unhandled event type"`.
- **Database records to inspect**: `WebhookEvent` row for this event,
  confirming `IGNORED` status.
- **Pass criteria**: `200`, `IGNORED` status, no other side effect.
- **Failure criteria**: any non-200 response, or an attempt to process
  the event as if it were handled.
- **Cleanup requirements**: none.

## Scenario 7 — Declined/failed payment

- **Objective**: confirm a `payment.failed` event correctly fails the
  `Payment` while leaving the order retryable.
- **Preconditions**: an `AWAITING_PAYMENT` `Payment` from a checkout
  session started with a PayMongo TEST card configured to decline.
- **Test environment**: Preview only.
- **Exact steps**: complete the hosted checkout using a PayMongo TEST
  declining card; wait for the `payment.failed` webhook.
- **Expected result**: `Payment.status → FAILED` (failure reason kept);
  `Order.status` **stays** `PENDING_PAYMENT` (retry is possible — this is
  the explicit, verified existing behavior, not merely the natural
  no-op).
- **Database records to inspect**: `Payment` (`status=FAILED`,
  `failureReason` populated); `Order.status` unchanged.
- **Email/timeline result**: `sendPaymentFailed` scheduled — order
  number + amount present, explains payment was not completed, includes
  a retry link.
- **Pass criteria**: exactly as above; a duplicate delivery of the same
  `payment.failed` event does not send a second `payment_failed` email
  (dedup via `EmailLog` idempotency key).
- **Failure criteria**: `Order.status` advances or regresses incorrectly,
  or a duplicate failure email is sent for the same event.
- **Cleanup requirements**: none.

## Scenario 8 — Expired/cancelled checkout

- **Objective**: confirm `checkout_session.expired` correctly marks the
  `Payment` expired.
- **Preconditions**: an `AWAITING_PAYMENT` session left unpaid until
  PayMongo expires it (or a synthetic TEST `checkout_session.expired`
  event for that session id, signature-valid).
- **Test environment**: Preview only.
- **Exact steps**: let a TEST checkout session expire (or send the
  corresponding webhook event), and observe the result.
- **Expected result**: `Payment.status → EXPIRED` (only if the current
  status can legally transition to `EXPIRED` — `canTransitionPayment`
  guards this); `Order.status` stays `PENDING_PAYMENT`.
- **Database records to inspect**: `Payment.status=EXPIRED`;
  `AdminAuditLog` row `action="payment.expired"`.
- **Email/timeline result**: `sendPaymentExpiredOrCancelled` scheduled.
- **Pass criteria**: as above.
- **Failure criteria**: `Order` status changes incorrectly, or the email
  fires on a redelivered/duplicate event.
- **Cleanup requirements**: none.

---

## Scenarios 9–13 — Refund scenarios

**Read this before running any of scenarios 9–13.** Each one has two
independent halves:

- **DB-only half** — creating the `PaymentRefund` row and its
  attribution/cap checks (`createAttributedPaymentRefund`,
  `deriveReturnSellerOrderId`). This does **not** depend on
  `config.mode`, and **is testable in Preview** via the same
  transaction-rollback pattern the existing `test-9f59-refund-attribution.ts`
  / `test-9f60-seller-cancellation-refund.ts` suites already use.
- **Provider-call half** — actually invoking PayMongo's `/refunds` API
  (`callProviderForRefund` → `createRefund`). This requires
  `refundRouteForOrder()` to return `route: "provider"`, which requires
  `config.mode === "live"` — **architecturally unreachable in Preview**
  under any TEST configuration, before or after the 2026-09-21
  activation-safety hardening (a live key is now explicitly blocked on
  Preview too). **`BLOCKED BY CURRENT ARCHITECTURE`** — this is not a gap
  in this checklist or a missing test capability; it is the intended
  design (refund-via-provider must only ever be reachable in genuine
  Production with a genuine live key). Do not invent a workaround (e.g.
  faking `VERCEL_ENV=production` on a Preview deployment) to force this
  path open.
- **Webhook-completion half** — a `refund.updated` event completing an
  already-initiated refund (`applyRefundUpdate`). This does **not**
  require `config.mode === "live"` and **is testable in Preview** via a
  signature-valid synthetic `refund.updated` TEST event against a
  `PaymentRefund` row created by the DB-only half (with a synthetic
  `providerId` standing in for what a real provider call would have set).

### Scenario 9 — Refund flow

- **Objective**: validate the DB-only refund-row creation end to end, and
  document that the live provider call cannot be exercised here.
- **Preconditions**: a PAID order with a real `Payment.metadata.providerPaymentId`
  (from Scenario 1/2) — for a DB-only test this can be fixture-seeded.
- **Test environment**: Preview only.
- **Exact steps** (DB-only half): create a `PaymentRefund` row via
  `createAttributedPaymentRefund` for a partial amount; confirm cap
  checks; separately, construct and POST a signature-valid synthetic
  `refund.updated` (`status: succeeded`) TEST event referencing that
  row's `providerId`.
- **Expected result**: `PaymentRefund.status: PENDING → SUCCEEDED`;
  `Payment.status → PARTIALLY_REFUNDED` or `REFUNDED` (by amount);
  `Order.paymentStatus` mirrors it.
- **Database records to inspect**: `PaymentRefund`, `Payment`, `Order`.
- **Pass criteria (DB-only + webhook-completion halves)**: as above.
- **Provider-call half**: `BLOCKED BY CURRENT ARCHITECTURE` —
  `refundRouteForOrder()` cannot return `route: "provider"` outside
  genuine Vercel Production with a genuine live key; do not attempt to
  force it.
- **Cleanup requirements**: delete the fixture `PaymentRefund`/`Payment`/
  `Order` rows created for this test.

### Scenario 10 — Refund idempotency

- **Objective**: confirm `callProviderForRefund`'s idempotency (a
  non-`PENDING` row is a no-op) and `refund.updated` redelivery safety.
- **DB-only half**: create a `PaymentRefund`, manually move it out of
  `PENDING` (simulating a completed provider call), then call
  `callProviderForRefund` again — expect `{ ok: true, alreadyProcessed:
  true }`, no second network attempt (none occurs regardless, since
  `PAYMONGO_SECRET_KEY` presence still can't reach `route: "provider"`
  from a real checkout, but the function-level idempotency is directly
  testable by calling it in isolation, exactly as the existing
  `test-9f60-seller-cancellation-refund.ts` §10 already does).
- **Webhook-completion half**: redeliver the same `refund.updated` event
  id twice — confirm only one `SUCCEEDED` transition, no duplicate sum.
- **Provider-call half**: `BLOCKED BY CURRENT ARCHITECTURE` — same
  reasoning as Scenario 9.
- **Pass criteria**: no duplicate state transition from either retried
  path.
- **Cleanup requirements**: delete fixture rows.

### Scenario 11 — Seller-aware refund attribution

- **Objective**: confirm `deriveReturnSellerOrderId` correctly attributes
  a single-seller return, and correctly refuses to attribute (returns
  `null`, `mixed: true`) a genuinely mixed-seller return.
- **DB-only half**: fully testable in Preview — mirrors
  `test-9f59-refund-attribution.ts`'s existing coverage. Build a return
  spanning one seller's items only, confirm `sellerOrderId` is set;
  build a return spanning two sellers' items, confirm `sellerOrderId:
  null, mixed: true` and that the Payment-level cap alone still applies.
- **Provider-call half**: `BLOCKED BY CURRENT ARCHITECTURE`.
- **Pass criteria**: attribution matches exactly for both the
  single-seller and mixed-seller cases; no split-refund mechanism is
  invented.
- **Cleanup requirements**: delete fixture Order/SellerOrder/Return rows.

### Scenario 12 — Seller cancellation after payment

- **Objective**: confirm `sellerCancelSellerOrder`'s in-transaction,
  DB-only `PaymentRefund` row creation, and that the post-commit provider
  call step correctly no-ops (rather than erroring) when the provider
  route can't be reached.
- **DB-only half**: fully testable in Preview — mirrors
  `test-9f60-seller-cancellation-refund.ts`'s existing coverage
  (cancellation succeeds and creates a `PENDING` `PaymentRefund` row
  scoped to `SellerOrder.total`, regardless of whether a later provider
  call could ever complete it).
- **Provider-call half**: `BLOCKED BY CURRENT ARCHITECTURE` — the
  post-commit call in `src/lib/seller/order-actions.ts` re-derives
  `refundRouteForOrder()`, which cannot return `"provider"` in Preview;
  confirm instead that it logs the `"blocked"` route
  (`MISSING_PROVIDER_PAYMENT_ID` is a *different* blocked reason than
  "not live mode" — in Preview the row simply never reaches the
  provider-call branch at all, so nothing is logged and the
  `PaymentRefund` row stays `PENDING`, visible to
  `reconcile:payments` rule 16 after 24h).
- **Pass criteria**: the cancellation itself always succeeds and is never
  rolled back by a refund-side failure, in any environment.
- **Cleanup requirements**: delete fixture Order/SellerOrder rows.

### Scenario 13 — Return-triggered refund

- **Objective**: confirm the admin return-refund action
  (`src/lib/admin/returns-actions.ts`) routes correctly to
  bookkeeping/blocked/provider and never regresses to using
  `Payment.providerId`.
- **DB-only half**: fully testable in Preview — confirm a COD/no-payment
  return still takes the bookkeeping path unchanged (byte-identical to
  pre-PayMongo behavior); confirm a PAID-payment return with online
  payment enabled routes toward `"provider"` far enough to reach the
  `providerPaymentId` extraction, and — for a fixture Payment whose
  `metadata.providerPaymentId` is deliberately absent — confirm the
  `"blocked"` route fires and the action returns a typed failure without
  ever calling `initiateProviderRefund`.
- **Provider-call half**: `BLOCKED BY CURRENT ARCHITECTURE` in Preview,
  same reasoning as Scenario 9.
- **Pass criteria**: the blocked-route guard is proven to trigger for a
  missing `providerPaymentId`, and the bookkeeping path is proven
  unaffected.
- **Cleanup requirements**: delete fixture Return/Order/Payment rows.

---

## Additional validation

### Reconciliation behavior

- Run `npm run reconcile:payments` and `npm run reconcile:marketplace`
  after any scenario above that wrote fixture rows, confirming the tool
  correctly flags (or doesn't) whatever state the scenario left behind,
  before cleanup removes the fixtures. Record the pass/warn/fail counts
  observed during testing, separately from the standing Production
  baseline (16/0/0 and 145/0/0).

### Malformed/invalid webhook payload handling

- **Objective**: confirm a structurally broken payload is rejected
  cleanly.
- **Exact steps**: send a signature-valid request whose body is not
  valid JSON, and separately one that is valid JSON but missing
  `data.id` or `data.attributes.type`.
- **Expected result**: `400` with body `"malformed payload"` (invalid
  JSON) or `"missing event id or type"` (missing fields) — in both
  cases, no `WebhookEvent` row is created (the parse happens after
  signature verification but before the event-id claim).
- **Pass criteria**: `400` in both cases, no database row created.

### Payment ID vs Checkout Session ID verification

**Mandatory for Scenario 1 or 2** — record, without exposing secrets:

| Field | Value observed | Source |
|---|---|---|
| PayMongo Checkout Session ID (`cs_xxx`) | | PayMongo hosted checkout URL / dashboard TEST event log |
| PayMongo Payment ID (`pay_xxx`) | | the `*.paid` webhook event's object id |
| Axiaro `Payment.providerId` | | `Payment` row, same order |
| Axiaro `Payment.metadata.providerPaymentId` | | `Payment` row, same order, after the `*.paid` webhook |
| PayMongo refund identifier (if a refund was tested) | | `PaymentRefund.providerId`, if the provider-call half was ever reachable |

**Expected relationship, to be explicitly confirmed:**
- `Payment.providerId` **=** the Checkout Session ID (`cs_xxx`).
- `Payment.metadata.providerPaymentId` **=** the actual PayMongo Payment
  ID (`pay_xxx`), and is **different** from `Payment.providerId`.
- The refund operation (`callProviderForRefund` → `createRefund`) must be
  confirmed, by code inspection of `src/lib/payments/refund.ts` at the
  time of testing, to use `metadata.providerPaymentId` — **never**
  `Payment.providerId` — as `payment_id` in the `/refunds` call. As of
  commit `6abf416` this is fixed and verified at the code level; this row
  exists so a future sandbox run re-confirms it hasn't regressed.

---

## Summary result table

| Scenario | Result | Evidence | Notes |
|---|---|---|---|
| 1 · Successful card payment | NOT RUN | | |
| 2 · Successful GCash payment | NOT RUN | | |
| 3 · Payment-session lifecycle | NOT RUN | | |
| 4 · Webhook signature verification | NOT RUN | | |
| 5 · Duplicate webhook delivery / idempotency | NOT RUN | | |
| 6 · Unhandled webhook event type | NOT RUN | | |
| 7 · Declined/failed payment | NOT RUN | | |
| 8 · Expired/cancelled checkout | NOT RUN | | |
| 9 · Refund flow (DB-only + webhook-completion) | NOT RUN | | Provider-call half: `BLOCKED BY CURRENT ARCHITECTURE` |
| 10 · Refund idempotency (DB-only + webhook-completion) | NOT RUN | | Provider-call half: `BLOCKED BY CURRENT ARCHITECTURE` |
| 11 · Seller-aware refund attribution (DB-only) | NOT RUN | | Provider-call half: `BLOCKED BY CURRENT ARCHITECTURE` |
| 12 · Seller cancellation after payment (DB-only) | NOT RUN | | Provider-call half: `BLOCKED BY CURRENT ARCHITECTURE` |
| 13 · Return-triggered refund (DB-only) | NOT RUN | | Provider-call half: `BLOCKED BY CURRENT ARCHITECTURE` |
| Additional · Reconciliation behavior | NOT RUN | | |
| Additional · Malformed/invalid webhook payload | NOT RUN | | |
| Additional · Payment ID vs Checkout Session ID | NOT RUN | | |

Allowed values: `PASS`, `FAIL`, `BLOCKED`, `NOT RUN`. No row above may be
marked `PASS` except by whoever actually executed that scenario and
recorded real evidence.
