# Lalamove Production activation — operator runbook

**Owner:** Axiaro Platform Operations
**Status of this document:** runbook only — no activation has occurred. Executing any step below sends real orders to a real courier dispatch network once credentials are added; nothing in this document should be run outside an approved change window, and only after explicit owner approval (§11).

This runbook is derived entirely from the audited implementation in `src/lib/shipping/` (`registry.ts`, `providers/lalamove.ts`, `webhook.ts`) and `src/lib/marketplace/seller-order-repository.ts` (`quoteSellerShipment`, `saveSellerShipment`), and from the Sandbox validation and audit work already performed (Lalamove Integration Tasks 1–15, this repository's own task history). It documents no Lalamove Partner Portal step that has not been independently observed from this codebase, from Vercel CLI output, or from a direct Partner Portal session this project already conducted — dashboard-side steps whose behavior is not yet confirmed are explicitly marked as such throughout.

---

## 1. Purpose and scope

This runbook covers the **controlled activation of Lalamove as a live shipping provider in Production**. It exists so that when explicit owner approval is given, the sequence to follow is already written down, reviewed, and grounded in the actual implementation — not improvised at activation time.

It distinguishes five clearly separate phases, and this document only fully covers the first two in detail; the later phases are scoped but explicitly gated on prerequisites this runbook cannot itself satisfy:

| Phase | Status |
|---|---|
| **Sandbox validation** | Partially complete — real SANDBOX quote and shipment creation validated (§10); SANDBOX webhook end-to-end delivery currently **blocked** |
| **Production configuration** | Not started — no Production credential, webhook, or `shipping.mode=live` change has been made |
| **Production activation** | Not started — gated on explicit owner approval (§11) and every item in §2 |
| **Post-activation verification** | Documented as a checklist (§7) for the future activation window; not yet executed |
| **Rollback / deactivation** | Documented (§9) based on the existing fail-closed gate; not yet exercised in Production, since Production has never been activated |

**Creating this runbook does not activate Lalamove.** No Production credential, StoreSetting, webhook, or Vercel configuration was changed to produce this document.

---

## 2. Current preconditions

Production activation must not proceed until every applicable item below is independently confirmed by Axiaro Platform Operations. Nothing in this section may be assumed complete. No requirement below has been invented beyond what the current implementation and prior audits (Task 15) actually established.

- [ ] Lalamove Production API credentials obtained (API key + secret, issued for the **live**, not sandbox, account) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Lalamove Production account/service readiness confirmed (merchant account activated, billing/settlement arrangement in place) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Production webhook registration requirements confirmed — currently **unknown**; the equivalent Sandbox registration is itself blocked (§10) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Sandbox webhook blocker ("Destination host unreachable") resolved, **or** formally accepted as an open risk by the owner before proceeding without full webhook validation — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Required courier service coverage confirmed for the intended launch region (Lalamove's PH service area matching Axiaro's actual seller/delivery footprint) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Business/operational approval obtained (pricing exposure, commission/cost model for live courier dispatch, seller-facing rollout plan) — NOT VERIFIED — OWNER ACTION REQUIRED
- [ ] Explicit owner approval obtained before activation (§11) — NOT VERIFIED — OWNER ACTION REQUIRED

---

## 3. Production environment variables

The following are **required** in Vercel **Production** before Lalamove can resolve as the active shipping provider there:

```
SHIPPING_LALAMOVE_API_KEY
SHIPPING_LALAMOVE_API_SECRET
SHIPPING_LALAMOVE_MODE=live
```

These must be configured **only** in the Vercel Production environment — never Preview, and never by copying the existing Sandbox credentials (those are scoped to Preview and to the Sandbox Lalamove account; Production requires its own live-account credentials per §2). **None of these variables have been added. This runbook does not add them.**

`SHIPPING_LALAMOVE_MODE` defaults to `"sandbox"` for any value other than the literal string `"live"` ([`mode()`, `src/lib/shipping/providers/lalamove.ts:52-54`](../src/lib/shipping/providers/lalamove.ts)) — an accidental typo or omission fails closed to sandbox base URLs against a live API key, not the reverse.

---

## 4. Production webhook

The intended Production webhook endpoint is:

```
https://axiaro.shop/api/webhooks/shipping/lalamove
```

This is the same generic, provider-agnostic route already deployed and live in Production today (`src/app/api/webhooks/shipping/[provider]/route.ts`) — no code change is required to point Lalamove at it; only the Lalamove-side registration and the Production credential (§3) are missing.

**The Lalamove Partner Portal's Production environment is a separate configuration from Sandbox**, selected via the same environment toggle used during Sandbox testing (confirmed directly in this project's own Partner Portal session — Production and Sandbox each have their own webhook URL, API keys, and webhook-attempt log). Registering the Sandbox webhook URL does **not** register the Production one, and vice versa.

**This runbook does not register the Production webhook now, and does not claim that webhook registration currently works.** The Sandbox registration of a comparable URL is currently blocked by the Lalamove Partner Portal reporting **"Destination host unreachable"** (§10) — an issue that remains open and whose root cause has not been confirmed by Lalamove Support as of this document. Whatever resolves the Sandbox issue must be re-verified against the separate Production registration before it can be assumed to work there too; one environment's success does not imply the other's.

One relevant, already-confirmed difference: `axiaro.shop` is a custom domain and is **not** behind Vercel Deployment Protection (`ssoProtection.deploymentType: "all_except_custom_domains"`, confirmed via `vercel project protection`) — unlike the Preview URL used for Sandbox testing, which required a Vercel Protection Bypass query parameter. This means the Vercel-protection-specific half of the Sandbox blocker's root-cause investigation (Task 14C/14D) would not apply to the Production URL. It does **not** mean the separate, still-unconfirmed query-parameter/validation question from Lalamove's side (Task 14D-7, `DOCUMENTATION INCONCLUSIVE`) is resolved for Production — that question was never Vercel-protection-specific to begin with.

---

## 5. StoreSettings

The current shared `shipping.*` StoreSettings (one Postgres table, read identically by Preview and Production) are:

```
shipping.integrationEnabled = true
shipping.provider           = LALAMOVE
shipping.mode                = test
```

**These are not changed by this runbook.**

### Why the shared setting is the central risk here

`shipping.integrationEnabled` and `shipping.provider` are already set to values that, on their own, would select Lalamove — the only thing currently preventing Production activation is the **absence of `SHIPPING_LALAMOVE_API_KEY` in the Production environment** ([`providerCredentialsPresent()`, `registry.ts:60-63`](../src/lib/shipping/registry.ts), part of the three-condition gate in `getShippingConfig()`). This was independently verified multiple times this session by direct code execution, not assumption: Production with no credential resolves `MANUAL`; the same shared settings with a credential bridged resolve `LALAMOVE`.

**Concrete consequence:** the moment `SHIPPING_LALAMOVE_API_KEY`/`_SECRET` are added to Vercel Production, Lalamove activates in Production on the very next settings read — there is no separate "arm Production" toggle to flip afterward, because the StoreSettings side of the gate is already satisfied today. Adding the Production credential **is** the activation event, not a step before it. This is the same category of risk documented in the PayMongo activation runbook (`docs/paymongo-production-activation.md` §1) for `payments.onlinePaymentEnabled`, and it argues for the same discipline: treat the credential add as the point of no return, not a routine configuration step.

`shipping.mode` currently reads `"test"`. **Changing it to `"live"` is a separate Production configuration decision, made in §6 Step F, and is not performed during this task.** Note that `shipping.mode` (the StoreSetting, informational/display field per `getShippingConfig()`) is distinct from `SHIPPING_LALAMOVE_MODE` (the environment variable that actually selects the Lalamove API base URL, §3) — both must be set consistently at activation time, but they are two different controls.

---

## 6. Activation sequence

This is the intended future order of operations. **None of these steps are performed by this runbook.** Each step is a single deliberate action; do not combine steps; record the timestamp, operator, and verification result for each before proceeding.

**A.** Obtain explicit owner approval (§11).
**B.** Confirm Lalamove Production account/service readiness (§2).
**C.** Confirm Production credentials have been issued by Lalamove.
**D.** Confirm Production webhook registration requirements — resolve or formally accept the open Sandbox blocker (§10) before assuming the same mechanism will work for Production.
**E.** Configure Production Vercel credentials (`SHIPPING_LALAMOVE_API_KEY`, `SHIPPING_LALAMOVE_API_SECRET`).
**F.** Configure `SHIPPING_LALAMOVE_MODE=live`.
**G.** Register the Production webhook in the Lalamove Partner Portal's Production environment tab.
**H.** Verify the Production configuration (§7) before processing a real order.
**I.** Perform the approved, controlled first Production shipment (§8).
**J.** Verify Lalamove's response (quote + booking confirmation).
**K.** Verify the Axiaro `Shipment` row's state.
**L.** Verify webhook processing for that shipment (event recorded, `lastCarrierStatus` updated).
**M.** Verify the corresponding `SellerOrder` transition, if any, matches the documented mapping (Task 15 §6).
**N.** Confirm monitoring/operations-alerting behavior (the exception-alert path) is observed to work, or is at minimum confirmed still correctly wired, during the first shipment's lifecycle.

---

## 7. Production pre-flight verification

To be executed during the future activation window, after Step G and before Step I.

**Configuration / read-only checks (no real order required):**

- [ ] `SHIPPING_LALAMOVE_API_KEY` / `_API_SECRET` present in Vercel Production (`vercel env ls production`)
- [ ] `SHIPPING_LALAMOVE_MODE=live` present in Vercel Production
- [ ] `resolveShippingProvider()` resolves to `LALAMOVE` in Production (verify via the same read-only simulation technique used throughout Sandbox validation, or an admin diagnostics view if one exists by then)
- [ ] Production mode confirmed live, not sandbox (`mode()` reads `"live"`, base URL is `rest.lalamove.com`, not `rest.sandbox.lalamove.com`)
- [ ] Production webhook URL (`https://axiaro.shop/api/webhooks/shipping/lalamove`) registered and shown as active in the Lalamove Partner Portal's Production tab
- [ ] Lalamove webhook registration accepted without a "Destination host unreachable" or equivalent error
- [ ] API connectivity confirmed — a real quote request against the live API succeeds (this alone does not require a real shipment/order, only a real quote call, per the existing `quoteSellerShipment()` read-only path)

**Checks that require a real Production shipment (cannot be verified read-only):**

- [ ] Shipment creation behavior — a real `saveSellerShipment()` call against a real seller/order succeeds end-to-end against the live API
- [ ] Webhook signature verification — a genuine live-mode Lalamove webhook is received and its signature validates
- [ ] Shipment status updates — `Shipment.status`/`lastCarrierStatus` update correctly from a real received event
- [ ] SellerOrder status cascade — a real `SHIPPED`/`DELIVERED` transition occurs correctly from a real webhook
- [ ] Exception handling — not verifiable pre-flight without deliberately inducing a cancellation; treat as unverified until naturally observed or deliberately tested with owner approval
- [ ] Idempotency — a genuine duplicate delivery (if Lalamove's retry behavior produces one naturally) is handled without a double transition or double alert
- [ ] Operations alerting — a real `sendLalamoveShipmentExceptionOps()` send is observed to fire correctly, if an exception event occurs

---

## 8. First Production shipment

The first Production shipment must be **deliberately controlled** — a real, operator-owned order, not a synthetic or disposable fixture, since Production has no equivalent of the Sandbox "disposable test product" pattern used throughout this project's Sandbox validation (that pattern was itself only ever authorized for Sandbox — see Task 10A–10F).

This runbook does not invent or specify a particular order, seller, or destination for that first shipment. It requires:

- Explicit owner approval, obtained separately from the general activation approval in §11 (this is a further, order-specific go-ahead)
- Every item in §2 and §7's read-only checks passing first
- The operator present and monitoring at the time the shipment is created

---

## 9. Rollback / deactivation

Based on the existing environment-credential gate (§5). **This has not been tested in Production** — Production has never been activated, so no rollback has ever been exercised for real; the sequence below is derived from the code's documented fail-closed design, not from a prior incident.

1. **Configuration rollback (fastest, no deploy strictly required for the DB-side settings, but the environment variable side needs one):** the shared `shipping.integrationEnabled`/`shipping.provider` settings could be flipped off, but this is a shared, cross-environment kill switch — turning it off also disables Preview's Sandbox configuration, which is a Preview-side side effect worth knowing about before using this as the primary rollback lever. The more targeted, Production-only rollback is credential removal (below).
2. **Credential removal:** remove `SHIPPING_LALAMOVE_API_KEY` (and, if desired, `_API_SECRET`/`_MODE`) from Vercel Production. This is the Production-scoped equivalent of the PayMongo runbook's credential-removal step, and — unlike the shared StoreSettings — does not affect Preview.
3. **Redeploy required:** a Vercel environment-variable change does not take effect until Production is redeployed, exactly as observed repeatedly during this project's own Preview configuration work (Task 11B → 11C). Removing the credential without redeploying leaves the stale value live until the next deploy.
4. **Webhook removal (external, dashboard-side):** disable or remove the Production webhook registration in the Lalamove Partner Portal if there is any concern the endpoint or credential has been compromised. This action happens outside this codebase — this runbook can note it is needed but cannot execute or verify it.
5. **StoreSettings changes:** if the shared `shipping.mode` was set to `"live"` (§6 Step F) and a full deactivation is intended (not just a Production credential pause), consider whether it should be reverted to `"test"` — but note this is a **shared** value read by Preview too, so reverting it affects Preview's own Sandbox configuration state, exactly as flagged in item 1.
6. **Verify dormancy:** after redeploy, confirm `resolveShippingProvider()` in Production resolves back to `MANUAL` — the same read-only verification technique used throughout this project's Sandbox work.

**Distinguishing the four rollback categories requested:**
- *Configuration rollback* = item 1 (shared StoreSettings) — has cross-environment side effects, use cautiously.
- *Webhook removal* = item 4 — external, Lalamove-side, cannot be executed from this repository.
- *Credential removal* = item 2 — Production-scoped, the most targeted lever, requires item 3 (redeploy) to take effect.
- *StoreSettings changes* = item 5 — the shared-mode-string revert, distinct from item 1's integration-enabled/provider toggle.

---

## 10. Current blockers

- **Sandbox webhook validation remains blocked** by the Lalamove Partner Portal reporting **"Destination host unreachable"** when attempting to register the Axiaro Preview webhook URL (with the Vercel Protection Bypass query parameter appended). The Sandbox webhook destination remains configured to `webhook.site`, unchanged.
- **Lalamove Support response is pending** — a support email has been drafted (not confirmed sent) requesting clarification on query-parameter handling, DNS/host validation, and the exact save-time validation request Lalamove's Partner Portal sends.
- **The full genuine Lalamove webhook lifecycle beyond `ASSIGNING_DRIVER` has not been verified end-to-end.** What has been validated: a real Sandbox quote (`POST /v3/quotations`, `ok: true`, ₱51.00) and a real Sandbox shipment creation (`POST /v3/orders`, `ok: true`, Lalamove order ID `3594332119939859234`) — `callLalamove()` only treats a non-2xx response as an error, so a 2xx status is implied by `ok: true` but was not independently printed in this session's test output — against a disposable test fixture. What has **not** been validated: any real `OUT_FOR_DELIVERY`, `DELIVERED`, `CANCELED`, `REJECTED`, or `EXPIRED` webhook actually reaching and being processed by the Axiaro application — this remains blocked by the same webhook-registration issue above.
- **No Production Lalamove credentials are configured** — confirmed absent via `vercel env ls production`.
- **No Production webhook has been registered** — the Lalamove Partner Portal's Production environment tab has not been touched in any session to date.

---

## 11. Approval gate

> ## PRODUCTION ACTIVATION REQUIRES EXPLICIT OWNER APPROVAL

**Completing this runbook does NOT activate Lalamove.** No step in §6 has been performed. No credential, webhook, or `shipping.mode` value has been changed. Nothing in this document authorizes any future step in §6 to proceed without a separate, explicit, contemporaneous approval from the owner at the time activation is actually intended — this document existing is preparation, not authorization.

---

## 12. Audit trail

- **Current branch:** `paymongo-test`
- **Current HEAD commit:** `1ba5ea0` — "fix: support lalamove initial webhook connection"
- **Relevant recent commit history on this branch:** `62f4d20` (webhook status cascade) → `7e58185` (exception ops alerting) → `a0de647` (quote action) → `c6a8c6a` (seller shipment UI) → `1ba5ea0` (initial-connection fix)
- **Relevant deployed Preview:** `dpl_DaAanJW4m3nz7KDmZvPz122DBxgy` (`https://shop-gjpgr1anw-noetikon-technologies.vercel.app`), READY, target `preview`
- **Reference to prior audit/implementation work:** Lalamove Integration Implementation Tasks 1–7 (provider/webhook/UI build), Task 8 (Preview readiness audit), Task 9 (publish + dormant Preview deploy), Tasks 10–10F (Sandbox disposable fixture creation), Task 11–11C (Preview SANDBOX credential configuration), Task 12 (real Sandbox quote validation), Task 13 (real Sandbox shipment creation validation), Task 14–14D-7 (webhook validation attempts, Vercel Deployment Protection bypass audit and use, Lalamove initial-connection-check implementation and deployment, ongoing Sandbox webhook registration blocker), Task 15 (Production readiness audit).
- **Confirmation that this runbook's creation does not change Production:** true — creating this file is a documentation-only change to the repository; no Vercel configuration, database row, or Lalamove Partner Portal setting was touched to produce it.
