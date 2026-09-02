# Email — operator guide

Axiaro sends two independent kinds of email. They never share a transport.

| | Transactional (this app) | Auth (Supabase) |
|---|---|---|
| Examples | order confirmation, shipped, delivered, cancelled, return updates, password-changed / sign-in-alert notices, contact-form replies | email verification, password reset, email-change confirmation |
| Sent by | `nodemailer` → SMTP relay (Brevo) | Supabase Auth's own mailer |
| Templates | hand-written in `src/lib/email/templates/*.ts` | pasted into the Supabase dashboard |
| Logged in `/admin/email` | yes | no |

---

## 1. Transactional pipeline

```
trigger (checkout / order / fulfilment / returns / auth / contact / webhook)
  → scheduleEmail(fn)                       runs AFTER the response (never blocks)
  → notifications.ts  send<X>(id)           re-reads the authoritative record
  → renderAndDispatch(meta, () => render<X>(...))
       ├─ getEmailFooter()                  contact.email + legal line (uncached)
       ├─ render<X>() throws → recordEmailFailure() → EmailLog FAILED
       └─ dispatchEmail(meta + message)
              ├─ EmailLog.createMany(skipDuplicates)   claim the idempotency key
              │     count 0 → DEDUPED, stop (unless an admin retry)
              ├─ not configured / EMAIL_MODE=log → EmailLog SKIPPED, no send
              └─ transport.ts (nodemailer) → Brevo SMTP → recipient
                    → EmailLog SENT (+ providerMessageId) | FAILED (+ error)
```

- **`dispatchEmail()` in `src/lib/email/send.ts` is the only place SMTP is called.** Do not send email anywhere else.
- **It never throws.** A provider error is recorded on the `EmailLog` row and swallowed — the order / status change that triggered the email is already committed and is unaffected.
- **`scheduleEmail()`** (`schedule.ts`) runs the send in `after()`, so the customer is never waiting on the SMTP provider.

### EmailLog / idempotency

- `EmailLog.idempotencyKey` is **`UNIQUE`**. Every send derives a deterministic key:
  - per record — `ORDER_CREATED:<orderId>`, `ORDER_SHIPPED:<orderId>`, `RETURN_APPROVED:<returnId>`, `WELCOME:<userId>`, …
  - windowed — `PASSWORD_CHANGED:<userId>:<UTC-hour>`, `SIGNIN_ALERT:<userId>:<uaHash>:<UTC-day>`, `SUPPORT_INBOUND:<digest>:<UTC-day>`
- A repeated event / webhook redelivery / double-click collides on the key → `DEDUPED`, nothing sent.
- **Never change an existing key format** — it would produce a duplicate send for every in-flight record.
- Statuses: `PENDING → SENDING → SENT`, or `FAILED`, or `SKIPPED`. `attempts` increments each time the row enters `SENDING`.
- The log stores **no message body, no token, no secret**. `error` is truncated to 500 chars.

### Order-event → email map

| Admin / system action | `Order.status` | Email |
|---|---|---|
| checkout (`createOrderFromCart`) | `PENDING_PAYMENT` | `order_confirmation` |
| **Confirm order** (pay-on-delivery) | `PENDING_PAYMENT → PROCESSING` | `order_processing` |
| Move to Processing (online-paid order) | `PENDING`/`PAID → PROCESSING` | `order_processing` |
| Mark as shipped | `PROCESSING → SHIPPED` | `order_shipped` (courier + tracking) |
| Mark out for delivery | `SHIPPED → OUT_FOR_DELIVERY` | `out_for_delivery` |
| Mark delivered / collected | `… → DELIVERED` | `order_delivered` |
| Cancel order | `… → CANCELLED` | `order_cancelled` |
| PayMongo webhook `payment.paid` *(dormant)* | `… → PAID`, then `PROCESSING` | `payment_confirmation` + `order_processing` |

Return / RMA emails follow the same shape against `ReturnRequest` (keys `RETURN_*:<returnId>`).

---

## 2. COD (pay-on-delivery) order lifecycle

The live store is COD-only. Checkout creates every order as `PENDING_PAYMENT` with no `Payment` row.

**To fulfil a COD order:** open it in `/admin/orders/<id>` → **Manage order → Confirm order**. This:

- moves `PENDING_PAYMENT → PROCESSING` (uses the normal transition guard, `codConfirm` scope),
- writes the `PROCESSING` OrderEvent,
- sends the customer the `order_processing` email,
- **does not** touch `paymentStatus` / `paymentMethod` and never implies a payment occurred.

After that, the standard Fulfilment panel (ship → out for delivery → delivered) and its emails work normally.

The **Confirm order** button is hidden if the order already has an online `Payment` — those are confirmed only by the verified PayMongo webhook.

---

## 3. Configuration

### Environment variables (Vercel → Production, all server-side, never `NEXT_PUBLIC_`)

| Var | Set in prod? | Notes |
|---|---|---|
| `EMAIL_HOST` | yes | Brevo SMTP relay host |
| `EMAIL_USER` | yes | Brevo SMTP login |
| `EMAIL_PASSWORD` | yes | Brevo SMTP key |
| `EMAIL_FROM_NAME` | yes | display name — `Axiaro` |
| `EMAIL_FROM` | **no** (intentional) | leaving it unset lets each message pick its own from-address (below); fallback = `orders@axiaro.shop` |
| `EMAIL_PORT` | no | defaults to 587 → STARTTLS |
| `EMAIL_REPLY_TO` | no | per-message Reply-To still applies (contact form, return-inbound → the customer) |
| `EMAIL_MODE` | no | set to `log` locally to record every email as `SKIPPED` without sending |

If `EMAIL_HOST` / `EMAIL_USER` / `EMAIL_PASSWORD` are not **all** set, every email is recorded `SKIPPED` and nothing is sent — no credentials are invented.

### From-addresses (per message)

| From | Used by |
|---|---|
| `orders@axiaro.shop` | all order emails, return-inbound (internal), payment / refund emails |
| `no-reply@axiaro.shop` | welcome, all security notices, contact-form acknowledgement, all customer-facing return notices |
| `support@axiaro.shop` | contact-form inbound (to the support inbox, Reply-To = customer) |

Footer support address and (optional) legal line are read from `StoreSetting` at send time: `contact.email`, `business.legalName` + `contact.addressLine1/2` / `city` / `country`. If `contact.email` is unset, the footer falls back to `support@axiaro.shop`.

### Provider

Brevo is used as a **plain SMTP relay only** — no Brevo API, no Brevo template IDs, no contact lists. The app builds the entire message (subject + HTML + text). To move to another provider (SES, Postmark, M365, …): change the four `EMAIL_*` vars. No code change — `transport.ts` is the only provider-aware file.

### DNS / deliverability (external — DNS zone + Brevo dashboard)

- **SPF** — TXT on `axiaro.shop` authorising Brevo's senders.
- **DKIM** — Brevo domain-key CNAMEs for `axiaro.shop`.
- **DMARC** — a published `_dmarc.axiaro.shop` policy.
- The Brevo account's sender domain must be **verified**.

### Supabase Auth emails

Separate system. To brand them: run `node --env-file=.env --import tsx scripts/gen-supabase-templates.ts --write`, paste the 5 generated templates + subjects into **Supabase → Authentication → Emails → Templates**, and point **Auth → SMTP** at the same Brevo account with an `@axiaro.shop` sender. All links resolve through `/auth/callback?next=…` (`NEXT_PUBLIC_SITE_URL`). **Do not change Supabase Auth behaviour from the app.**

---

## 4. PayMongo — dormant

`payment_confirmation`, `refund_completed`, and the provider-refund path are wired **only** to the PayMongo webhook. Production has no `PAYMONGO_*` env var, so the webhook fails closed and none of these can fire. Leave as-is until PayMongo is intentionally resumed.

---

## 5. Troubleshooting

| Symptom | Where to look |
|---|---|
| Customer didn't get an email | `/admin/email` — filter by order number. Check `status` and `error`. |
| Status `SKIPPED` | SMTP not configured, or `EMAIL_MODE=log`. Check the Vercel env vars. |
| Status `FAILED` | `error` column has the provider message. Use **Retry** for order / welcome / payment emails (security / return / support / provider-refund emails are deliberately **not** retryable — they carry time-of-event content). |
| Status `FAILED` with `render_failed: …` | a template threw. The order is unaffected; fix the template/data and retry (if retryable) or re-trigger the event. |
| No row at all for an expected email | the trigger's guard suppressed it (e.g. welcome is skipped for admin accounts; `order.email` missing) — check server logs for `[email] …`. |
| Duplicate email | shouldn't happen — the `UNIQUE` idempotency key prevents it. If seen, check for a key-format change. |
| Retry does nothing | the email type is non-retryable, or the row is already `SENT` (`DEDUPED`). |

**Retry** (`/admin/email`) re-runs the matching notification with the original idempotency key, so it can never become a second row or a second send. Gated on `view_audit_logs`; every retry writes an `AdminAuditLog` entry.

There is **no automatic retry** — a transient provider failure needs a manual retry click.
