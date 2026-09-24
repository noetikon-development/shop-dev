# PayMongo Production activation — operator runbook

**Owner:** Axiaro Platform Operations
**Status of this document:** runbook only — no activation has occurred. Executing any step below is a live, real-money action once credentials are added; nothing in this document should be run outside an approved change window.

This runbook is derived entirely from the audited implementation in `src/lib/payments/` (`config.ts`, `checkout-session.ts`, `webhook.ts`, `refund.ts`, `status.ts`) and from `src/lib/marketplace/reconcile-payments-core.ts`. It documents no PayMongo dashboard step that has not been independently confirmed from this codebase or from Vercel/database metadata — dashboard-side steps are explicitly marked as unverified in §7.

---

## 1. Current state (as of this audit)

| Signal | Value | Verified via |
|---|---|---|
| `PAYMONGO_SECRET_KEY` in Vercel Production | **absent** | `vercel env ls production` (12 vars listed, none PayMongo-related) |
| `PAYMONGO_WEBHOOK_SECRET` in Vercel Production | **absent** | same |
| `payments.mode` (StoreSetting, shared) | `""` → resolves to `"test"` | direct read-only DB query |
| `payments.onlinePaymentEnabled` (StoreSetting, shared) | `true` | direct read-only DB query |
| `payments.holdForReview` (StoreSetting, shared) | `true` | direct read-only DB query |
| Real `Payment` rows | 2 (TEST-mode, from Preview validation) | DB count |
| Real `PaymentRefund` rows | 0 | DB count |
| Real `WebhookEvent` rows | 4 | DB count |

**Production PayMongo is dormant.** `getPaymentsConfig()` computes `hasSecretKey = false` for Production today, which alone forces `sessionsEnabled = false` regardless of the shared `onlinePaymentEnabled` setting — no code or setting change is required to keep Production off; the absence of a Production secret key is the only thing currently preventing activation.

### Why the shared setting is the central risk in this runbook

`payments.mode` and `payments.onlinePaymentEnabled` are rows in one `StoreSetting` table read by **both** Preview and Production — there is no environment-scoped variant of either. This has one concrete, load-bearing consequence for the sequence in §5:

> `payments.onlinePaymentEnabled` is **already `true` today**. The moment a Production `PAYMONGO_SECRET_KEY` is added while that shared switch is still `true`, `sessionsEnabled` becomes `true` for Production on the very next settings read — there is no separate "arm Production" step. Adding the credential and enabling payments are, today, the same event unless the switch is deliberately turned off first.

This is why the sequence in §5 disables the switch **before** any credential is added, and treats re-enabling it as the single, deliberate, final activation step — never bundled with the credential add.

**Production must remain dormant until the change window** precisely because of this coupling: any Production `PAYMONGO_SECRET_KEY` added outside a controlled window, while the shared switch is on, activates live payments immediately and unintentionally.

---

## 2. Prerequisites

### A. PayMongo external prerequisites — NOT VERIFIED — OWNER ACTION REQUIRED

- [ ] PayMongo merchant/business account fully activated (KYC / business verification complete) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Live API secret key issued (`sk_live_…`) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Live webhook signing secret issued — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Production webhook registered in the PayMongo dashboard against `https://axiaro.shop/api/webhooks/paymongo` — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Card and GCash payment methods approved for live use on the account — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] PayMongo dashboard access confirmed for the operator executing this runbook — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Any outstanding PayMongo onboarding/compliance steps (business documents, settlement bank account) completed — NOT VERIFIED — OWNER ACTION REQUIRED

None of the above may be assumed complete. This runbook does not start until every item in this section is independently confirmed by Axiaro Platform Operations.

### B. Axiaro prerequisites

- [ ] Vercel Production environment-variable write access confirmed for the operator
- [ ] `StoreSetting` write access confirmed (admin `/admin/payments` or equivalent operator tooling)
- [ ] `vercel deploy --prod` access confirmed, from a real branch checkout (never a detached-HEAD worktree — see deployment history precedent)
- [ ] Axiaro Platform Operations designated as the on-call owner for the change window (§9)

### C. Technical prerequisites — already exercised in TEST mode; re-verify before go-live

- [ ] Checkout session creation (`checkout-session.ts`) — confirmed working in TEST mode; must be re-confirmed against the **live** API base during the smoke test (§7)
- [ ] Webhook signature verification (`webhook.ts` — `t=,te=,li=` header parsing, timing-safe HMAC, 300s skew limit) — confirmed working against TEST-mode payloads; must be re-confirmed against a real live-mode webhook delivery
- [ ] Webhook idempotency (`WebhookEvent.providerId` unique constraint) — confirmed working in TEST mode
- [ ] Payment state transitions (`applyPaid` — amount re-validated against both `Payment.amount` and live `Order.grandTotal`) — confirmed working in TEST mode
- [ ] Refund readiness (`refundRouteForOrder` / `initiateProviderRefund`, both gated on `config.mode === "live"`) — **this code path has never executed against a real live refund**; it is architecturally gated correctly but functionally unverified until the first live refund occurs
- [ ] Reconciliation readiness (`npm run reconcile:payments`) — confirmed working against TEST-mode data; must be run again after the smoke test against real live-mode data

---

## 3. Activation sequence

Each step is a single deliberate action. Do not combine steps. Record the timestamp, the operator, and the verification result for each step before proceeding to the next.

### PRE-CHECK
Confirm §1's current-state table still holds (no drift since the last audit) and every item in §2A is confirmed complete by Axiaro Platform Operations. Confirm the change window is active (§10).

### Step 1 — Disable `payments.onlinePaymentEnabled`
Set the shared `payments.onlinePaymentEnabled` StoreSetting to `false`.

This immediately stops **all** new checkout sessions — Preview TEST-mode included, because the setting is shared. **Preview TEST validation is paused for the duration of the activation window.** This is the deliberate kill-switch-first step; nothing in §3 proceeds until this is confirmed off.

### Step 2 — Add Production live credentials
Add `PAYMONGO_SECRET_KEY` (live) and `PAYMONGO_WEBHOOK_SECRET` (live) to the Vercel **Production** environment only — never Preview. Redeploy Production so the runtime picks up the new environment variables.

Credentials are never added before Step 1 completes — see §1's shared-setting risk.

### Step 3 — Set `payments.mode = "live"`
Set the shared `payments.mode` StoreSetting to `"live"`. This is safe at this point specifically because `onlinePaymentEnabled` is still `false` from Step 1 — nothing can activate yet.

### Step 4 — Verify the Production environment gate
Before touching the online-payments switch again, confirm via `getPaymentsConfig()` (or the `/admin/payments` diagnostics view) that Production now reads:

- `detectedMode = "live"`
- `isProdEnv = true`
- `modeMismatch = false`
- `hasSecretKey = true`
- `hasWebhookSecret = true`
- `sessionsEnabled = false` (because `onlinePaymentEnabled` is still `false`)

This proves the environment gate is correctly wired **before** anything can process a real payment. If any of these five values differs from what's listed, stop and treat it as a blocking defect — do not proceed to Step 5.

### Step 5 — Register/verify the Production webhook
Confirm with PayMongo (dashboard, or their own verification/ping mechanism if offered) that the live webhook is registered against the Production URL and reachable. This is an external, dashboard-side action — this runbook cannot execute or verify it from the repository.

### Step 6 — Confirm online payments remain disabled
Re-read the diagnostics from Step 4. Confirm `sessionsEnabled` is still `false`. This is a deliberate checkpoint, not a redundant repeat of Step 4 — it confirms nothing in Steps 2, 3, or 5 accidentally changed the shared switch.

### Step 7 — Re-enable `payments.onlinePaymentEnabled`
Set the shared `payments.onlinePaymentEnabled` StoreSetting back to `true`.

**This is the single moment Production can begin processing real payments.** Do this alone, deliberately, with the operator watching the diagnostics immediately afterward. Expected result:

- `sessionsEnabled` → `true`
- `onlinePaymentEnabled` → `true`
- Production is now intentionally live.

### Step 8 — Controlled Production smoke test
Perform exactly one small, operator-owned Production transaction. See §7 for what to verify.

### Step 9 — Verify webhook/payment/order state
Confirm the live webhook fired, the `WebhookEvent` row reached `PROCESSED`, the `Payment` row reached its expected status, and the `Order` reached its expected status. See §7 for the full checklist.

### Step 10 — Run reconciliation
Run `npm run reconcile:payments` (and `reconcile:marketplace`) against the new real transaction. Confirm zero mismatches.

### Step 11 — Final verification
Confirm the `/admin/payments` diagnostics reflect live mode as intended, confirm no TEST-mode residue remains, and confirm the designated owner has reviewed the smoke-test transaction end-to-end. Record the deployment ID, timestamps, and every verification result per §10.

---

## 4. Configuration verification reference

**Immediately before Step 7 (re-enabling), Production diagnostics must read:**

```
detectedMode      = live
isProdEnv         = true
modeMismatch      = false
hasSecretKey      = true
hasWebhookSecret  = true
sessionsEnabled   = false   (because onlinePaymentEnabled is still false)
```

**Immediately after Step 7:**

```
sessionsEnabled       = true
onlinePaymentEnabled  = true
```

Production is now intentionally live. No other diagnostic field is expected to change between these two checkpoints — if one does, treat it as unexplained and stop before Step 8.

---

## 5. Controlled Production smoke test (Step 8 detail)

Perform exactly one small, operator-owned transaction. Do not specify or record the real payment amount or any credential in this document — record actual values only in the operator's own private change-window log.

Verify:

- [ ] Checkout session was created against the **live** PayMongo API base, not the sandbox/test base
- [ ] The resulting `Payment` row is associated with the correct `Order`
- [ ] The webhook delivery's signature validates (HMAC check passes, 300s skew respected)
- [ ] The corresponding `WebhookEvent` row reaches status `PROCESSED`
- [ ] The `Payment` reaches its expected status (`PAID` for a successful method)
- [ ] The `Order` reaches its expected status following `applyPaid`
- [ ] No duplicate `Payment` or duplicate `WebhookEvent` was created (idempotency held)
- [ ] `npm run reconcile:payments` reports no mismatch for this transaction

If any check fails, do not attempt a second live transaction to "test again" — stop and go to §6 (rollback).

---

## 6. Rollback

Rollback is layered — always start with the fastest, no-deploy action.

1. **Immediate kill switch (no deploy required):** set `payments.onlinePaymentEnabled = false`. This alone halts all new checkout sessions, TEST and LIVE, on the next settings read.
2. **Stop new checkout activity:** confirm via diagnostics that `sessionsEnabled` is now `false` in Production.
3. **Webhook rollback (external, dashboard-side, only if required):** disable or delete the live webhook registration in the PayMongo dashboard if there is any concern the endpoint or secret has been compromised. This action happens outside this codebase — this runbook can note it is needed but cannot execute it.
4. **Credential rollback:** remove `PAYMONGO_SECRET_KEY` and `PAYMONGO_WEBHOOK_SECRET` from Vercel Production, or rotate/revoke the live key directly with PayMongo if compromise is suspected.
5. **Set `payments.mode` back to test/blank:** restore the shared `payments.mode` StoreSetting to `""` (or `"test"`) once online payments are confirmed off, so a subsequent Preview TEST-mode resumption does not collide with a stale `"live"` value.
6. **Redeploy only if required:** a redeploy is only needed if Vercel environment variables were changed (Step 4 above) — the credential removal does not take effect until Production is redeployed.
7. **Verify Production remains dormant:** re-run the Step 4 diagnostics check and confirm `hasSecretKey = false` (or `sessionsEnabled = false` if the key was intentionally left but disabled via the switch).
8. **Resume Preview TEST mode only after shared settings are restored appropriately:** re-enable `payments.onlinePaymentEnabled = true` and confirm `payments.mode` reads as TEST-compatible, then confirm Preview's own TEST-mode checkout works again before considering the incident closed.

This ordering exists so that the very first action in any rollback — the shared kill switch — requires no deploy and takes effect within one settings-read cycle, before any slower, dashboard- or deploy-dependent step begins.

---

## 7. Incident ownership

**Owner: Axiaro Platform Operations**

Response expectations for each scenario below assume the operator has this runbook open and starts, in every case, by considering Step 1 of §6 (the kill switch) if there is any doubt about whether new checkout activity should continue.

- **Payment not confirmed:** check the `WebhookEvent` table for a matching, unprocessed or failed row around the transaction's `Order` creation time; check `EmailLog` for a FAILED row from the payment-confirmation email path; check PayMongo's own dashboard for the checkout session's status before assuming the payment itself failed.
- **Duplicate payment concern:** check for more than one `Payment` row against the same `Order`, and more than one `WebhookEvent` row with the same `providerId` — the unique constraint on `providerId` is the idempotency mechanism, so a genuine duplicate would have to bypass or predate it; treat any duplicate as a defect to investigate, not a race to paper over.
- **Webhook missing:** confirm the webhook is still registered and active in the PayMongo dashboard; confirm `PAYMONGO_WEBHOOK_SECRET` in Production still matches what PayMongo has on file; check Vercel function logs for `/api/webhooks/paymongo` around the expected delivery time for a rejected-signature or timeout entry.
- **Refund failure:** confirm `config.mode === "live"` still holds (the code path is gated on this); check the `PaymentRefund` row's status and error detail; this path has no live-mode precedent yet (§2C), so treat any live refund failure as requiring careful manual review rather than a routine retry.
- **Reconciliation mismatch:** treat any live-mode mismatch reported by `npm run reconcile:payments` as higher severity than a TEST-mode mismatch would have been — investigate the specific `Order`/`Payment` pair named in the report before taking any further action, and do not re-run reconciliation repeatedly hoping the mismatch clears on its own.

No specific escalation contact or paging tool is documented here — none was established in the audit this runbook is based on. Axiaro Platform Operations should attach the organization's actual on-call contact path to this document before it is relied upon operationally.

---

## 8. Change-window rules

- Production activation (§3) must occur only during an approved change window.
- Preview TEST activity is considered paused for the duration of the shared-setting transition (Steps 1–7) — this is expected, not an incident.
- No unrelated Production changes (deploys, other StoreSetting edits, schema migrations) should occur during the activation window — isolate this change so any problem observed during or after it has one clear cause.
- The operator must record, for the change-window log: the deployment ID used, the timestamp of each step in §3, and the verification result of each checklist item in §4/§5/§9 (Final verification).

---

## 9. What this runbook cannot verify

The following are outside what this repository, its database, or Vercel's CLI can confirm, and must be independently confirmed by Axiaro Platform Operations before §3 begins:

- PayMongo dashboard account status and standing
- Whether live credentials have actually been issued
- Whether the Production webhook is actually registered in PayMongo's system
- Whether Card/GCash live payment methods are actually approved for the account
- Merchant compliance/onboarding completion status

This document assumes none of these are complete until Axiaro Platform Operations states otherwise.
