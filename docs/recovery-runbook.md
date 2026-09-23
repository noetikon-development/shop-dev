# Axiaro Production Recovery Runbook

Operational runbook for recovering the Axiaro Production environment after an
incident. This document was created following the 2026-09-17 Backup &
Recovery Readiness Audit, which found no formal recovery documentation
existed in this repository.

**This is a documentation artifact.** It does not automate recovery, and it
does not claim capabilities the project has not verified.

## A. Purpose and Scope

This document covers recovery of the Axiaro Production environment across
four distinct, independent surfaces:

- **Application rollback** — reverting the deployed Next.js application to a
  previous known-good build.
- **Database recovery** — restoring or repairing the shared Supabase Postgres
  database (schema and/or data).
- **Storage recovery** — restoring binary objects held in Supabase Storage
  (product imagery, seller verification documents).
- **Configuration recovery** — reconstructing Vercel environment variables
  and other configuration if lost.

These four surfaces are **independent of one another**. Recovering one does
not recover the others. A real incident may require any single one of these,
or a **combined application + database recovery**, handled as its own
category (§C.6, §E, §G) precisely because rolling back the app does not
touch the database and vice versa.

## B. Current Production Architecture

- **Vercel** — application hosting and deployment. Deployments are pushed
  from a local checkout via the Vercel CLI (`vercel deploy --prod`), not via
  a GitHub-integrated auto-deploy pipeline.
- **Supabase / PostgreSQL** — the application's single database. Preview,
  Production, and local development all read and write the **same**
  database — there is no per-environment data isolation.
- **Supabase Storage** — binary object storage, separate from Postgres. Two
  buckets are in use: `media` (public product/category imagery) and
  `seller-verification` (private seller KYC/identity documents).
- **Git / GitHub** — source repository (`noetikon-development/shop-dev`).
  Branch `paymongo-test` is the working branch used for recent promotions.
- **Vercel Environment Variables** — Production secrets and configuration
  (database connection strings, Supabase keys, SMTP credentials, PayMongo
  keys). Values are never committed to Git. No secret values appear in this
  document or should ever be added to it.

## C. Incident Classification

Classify the incident before acting. The category determines which sections
below apply.

1. **Application-only incident** — a bad deploy causes broken behavior, but
   the database is untouched. → Application rollback only (§E).
2. **Database/schema incident** — a migration or schema change causes an
   issue. → Database recovery (§G) + Schema/migration understanding (§J).
   Do not treat an application rollback as a fix for this category.
3. **Data corruption / accidental modification** — business data was wrongly
   created, changed, or deleted. → Database recovery (§G), dependent on a
   verified backup/PITR capability (§F) that this project has not verified.
4. **Storage incident** — media or verification documents are lost, corrupted,
   or deleted from Supabase Storage. → Storage recovery (§H), independent of
   database recovery.
5. **Configuration/environment incident** — Vercel environment variables or
   the Vercel↔project link are lost or misconfigured. → Configuration
   recovery (§I).
6. **Combined application + database incident** — a bad deployment and a bad
   database change happened together (e.g. a code change paired with a
   schema migration that together caused the issue). → Both §E and §G apply,
   sequenced deliberately (§D, §G) — never assume fixing one fixes the other.

## D. Incident Assessment

Before changing anything:

1. **Identify the current Production deployment.** Check `docs/deployments.md`
   for the most recent recorded entry (commit + Vercel deployment ID). If the
   log is out of date, use `vercel ls shop-dev --scope noetikon-technologies`
   to see the deployment history, and `vercel inspect <url>` to confirm
   status/target/aliases — note that Vercel's own deployment metadata does
   **not** expose a Git commit SHA for this project (see §E), so
   `docs/deployments.md` is the authoritative source for that mapping.
2. **Record the current Git commit**, if it can be determined (from
   `docs/deployments.md`, or from whoever most recently promoted).
3. **Record the Vercel deployment ID** currently aliased to `axiaro.shop`
   (`vercel inspect https://axiaro.shop --scope noetikon-technologies`).
4. **Determine whether the database was changed** — compare current
   business-data counts (Order, SellerOrder, Payment, PaymentRefund,
   ReturnRequest, Seller, SellerSettlement, Product) against the last known
   baseline (§L). A mismatch means the database itself needs attention, not
   just the application.
5. **Determine whether Storage was affected** — check whether expected media
   assets / verification documents are missing or altered.
6. **Determine whether environment configuration was affected** — check
   Vercel's Environment Variables dashboard against `.env.example`'s expected
   keys for the current environment.
7. **Stop further deployments** if the incident is still active or not fully
   understood — do not promote additional changes on top of an unresolved
   incident.
8. **Preserve incident evidence** — record exact counts, error messages,
   timestamps, and the deployment IDs involved before taking any recovery
   action, so the sign-off (§M) can be completed accurately.

**Application rollback does NOT automatically roll back database schema or
data.** These are two separate systems recovered by two separate procedures.

## E. Application Rollback

The currently verified method, used consistently in this project's own
promotion history:

```bash
git checkout <known-good-sha>
vercel deploy --prod --yes --scope noetikon-technologies
```

This builds a **fresh** Production deployment from the selected source
commit — it is not a reuse of a previously-built artifact. Confirm the
checked-out commit is correct (`git rev-parse HEAD`) before running the
deploy.

**Known limitation** (confirmed in the 2026-09-17 audit): a historical Vercel
deployment can, in principle, be re-promoted to Production. However,
`vercel promote <url>` on a deployment that is not already a `production`
-target deployment triggers an interactive rebuild confirmation prompt rather
than an instant, zero-rebuild alias flip. **This project does not currently
have a guaranteed instant-rollback mechanism** — every rollback performed
this way is a fresh build. No alternative mechanism is documented here
because none has been verified; do not assume one exists.

## F. Database Backup Verification

This project currently does **not** verify, and this document makes **no
claim** about:

- Supabase project plan/tier
- whether Point-in-Time Recovery (PITR) is enabled
- backup retention window
- backup availability
- restore capability or restore time

**These must be verified directly in the Supabase dashboard before any
incident response relies on them.** Do not assume backups exist, are recent,
or are restorable, based on this document or on Supabase's general
platform capabilities — only a checked dashboard state is trustworthy.

### Verified PostgreSQL-level WAL archiving evidence (2026-09-17)

A read-only check of Postgres system views (`pg_stat_archiver`, `SHOW
wal_level`) against the Production database, performed 2026-09-17, found:

- `wal_level = logical`
- `pg_stat_archiver.archived_count = 2,834`
- `pg_stat_archiver.failed_count = 0`
- `last_archived_time = 2026-09-17T06:32:22Z`
- `stats_reset = 2026-08-25T20:32:01Z`

This confirms WAL archiving activity is verified at the PostgreSQL level, but
this does not by itself establish that customer-accessible Supabase backup
or Point-in-Time Recovery is enabled for this project. Supabase runs WAL
archiving as part of its own infrastructure across plan tiers — its presence
does not confirm the plan/tier, whether automated backups or PITR are
enabled as a customer-facing feature, any retention window, that a specific
recoverable restore point exists, or that a restore has ever been tested.
None of those remain any more verified than before this check: Supabase
plan/tier, automated backup configuration, PITR status, PITR/backup
retention, recovery-point availability, and restore capability are all
**still NOT VERIFIED**, because dashboard/Management API access is
unavailable in this environment. This also says nothing about Supabase
Storage — no Storage backup capability is verified or claimed.

### Supabase Backup/PITR Verification — 2026-09-23

A follow-up read-only audit, performed 2026-09-23, re-checked the same
PostgreSQL system views and added two checks the 2026-09-17 pass did not
run (`SHOW archive_mode`, `SHOW archive_command`). No Supabase Dashboard or
Management API access was available for this audit either — the same
limitation as 2026-09-17.

**A. Production database identity — VERIFIED**

- Supabase project ref: `lccwdwsmidjdjhrzjixr` (confirmed independently via
  `supabase/config.toml`'s `project_id` and the `lccwdwsmidjdjhrzjixr.supabase.co`
  Storage URLs the live site actually serves).
- Database: `postgres`.
- PostgreSQL version: `17.6`.
- Preview, Production, and local development currently share this single
  database — already documented above (§B); re-confirmed, not independently
  re-verified, in this pass.

**B. Infrastructure-level WAL evidence — VERIFIED**

- `archive_mode = on`.
- `archive_command = '/usr/bin/admin-mgr wal-push %p >> /var/log/wal-g/wal-push.log 2>&1'`
  — continuous archiving via **WAL-G**.
- `pg_stat_archiver.archived_count` has increased from 2,834 (2026-09-17) to
  approximately 3,022 (2026-09-23) — archiving is ongoing, not a one-time or
  stalled process.
- `pg_stat_archiver.failed_count = 0` in both the 2026-09-17 and 2026-09-23
  checks — no observed archiver failures.

**WAL archiving activity is infrastructure-level evidence and does not by
itself establish customer-facing backup/PITR entitlement, enablement,
retention, or restore capability.** Do not read the items above as evidence
that PITR is enabled, that a specific restore point exists, or that a
restore would succeed.

**C. Backup/PITR items requiring Dashboard access**

| Item | Status |
| --- | --- |
| Production Supabase plan/tier | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| Automated backup schedule | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| Backup retention window | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| PITR availability (plan entitlement) | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| PITR enabled/disabled status | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| PITR retention/recovery window | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| Earliest restorable point | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |
| Documented/supported restore mechanism | **NOT VERIFIED** — Supabase Dashboard/Management API access required. |

**D. Recovery mechanisms — current state**

- **Vercel application rollback/deployment** is available (§E), but is a
  fresh build from a chosen commit — **not an instant rollback**.
- **No verified database restore procedure exists** — neither a Supabase-side
  one (blocked on dashboard access, table above) nor a repository-side one.
- **`npm run db:dump-seed` (`scripts/dump-seed-sql.mjs`) is NOT a
  disaster-recovery backup.** It intentionally excludes all
  transactional/business data — its own source comment lists `User, Address,
  Order*, Review, WishlistItem, UserRole, AdminInvite, AdminAuditLog` as
  deliberately excluded — and only snapshots catalogue/reference tables
  (`Category, Product, ProductImage, ProductOption, ProductOptionValue,
  Variant, VariantOptionValue, Inventory, Coupon, StoreSetting,
  ShippingMethod, ContentPage, ContentBlock, Permission, Role,
  RolePermission`) for local-dev seeding. It provides no recovery path for
  orders, payments, sellers, or users.
- **No `db:backup` or `db:restore` script exists** in `package.json` —
  confirmed directly against the full script list.
- **No CI/CD pipeline or scheduled job** referencing a database backup was
  found anywhere in this repository.
- **No verified Supabase Storage backup/recovery mechanism exists** for the
  `media` or `seller-verification` buckets (see §H, unchanged).

**E. RPO / RTO**

**RPO: NOT VERIFIED.**
**RTO: NOT VERIFIED.**

- WAL archiving activity does not, by itself, establish this project's
  actual recoverable window — it shows continuous data capture is
  *occurring*, not what window is *restorable* on this plan.
- No restore has ever been performed or timed against this project, so no
  RTO can be estimated from experience.
- No dashboard-confirmed retention or restore capability is available to
  derive either figure from. Do not substitute an assumed or
  industry-typical number for either value.

**F. Recovery-readiness gaps**

1. No Supabase Dashboard/Management API access is available from this
   environment or any prior audit — every backup/PITR-specific fact (plan,
   retention, enabled/disabled status, earliest restorable point) is
   unverifiable from here and requires someone with dashboard access.
2. No database restore has ever been tested — even if a backup/PITR
   capability turns out to be enabled, RTO remains unknown until one is
   tested.
3. No real transactional-data backup tooling exists in this repository —
   `db:dump-seed` is the only dump-like script, and it is scoped to
   demo/catalogue data only (see D above).
4. `db:dump-seed`'s name could cause a future operator to mistake it for a
   backup mechanism during an actual incident; it is not one.
5. No verified Supabase Storage backup/recovery procedure exists for the
   `media` or `seller-verification` buckets.
6. The existing schema/migration rebuild process (§J) — no
   `_prisma_migrations` tracking table, manual `supabase/migrations/*.sql`
   application in filename order — has limitations that compound the risk
   of a from-scratch rebuild during a real disaster, independent of whether
   the underlying *data* can be restored.

**G. Required follow-up information (outstanding, requires Supabase Dashboard access)**

The following remain outstanding and require an operator with authorized
Supabase Dashboard access to check directly — **do not fabricate values for
any of these fields**:

- Production Supabase plan/tier
- Automated backup configuration and schedule
- Backup retention window
- Whether PITR is enabled for this project
- PITR retention/recovery window, if enabled
- Earliest currently restorable point, if any
- The actual, dashboard-supported restore workflow (steps, expected
  duration, who can trigger it)

**H. Recommended future restore test (not executed)**

Once the items in **G** are confirmed, this project should run a **controlled
restore test in a non-Production environment** (a separate Supabase project,
or a project-branching/point-in-time-preview feature if the confirmed plan
supports one) to:

- validate that a restore actually succeeds end-to-end,
- measure the real time required (establishing an evidence-based RTO), and
- validate the recovery procedure documented in this runbook actually works
  as written, rather than remaining a paper procedure.

This test is **recommended, not performed**. No restore of any kind was
executed as part of writing this section.

## G. Database Recovery

Decision process:

1. **Do not attempt an application rollback as a substitute for database
   recovery.** They are unrelated; an application rollback leaves the
   database exactly as it was.
2. **Database recovery depends on an actual, verified Supabase backup/PITR
   capability, or an independent database backup** obtained outside this
   repository. Until §F is verified for the current incident, no restore
   path can be assumed to exist.
3. **Do not execute destructive recovery commands without first confirming
   the recovery point and the full scope of the incident.** A restore to the
   wrong point in time, or a restore performed before the incident's scope
   is understood, can destroy legitimate data created after the bad change.

**This repository currently contains no automated database restore
procedure.** There is no `db:backup`, `db:dump`, or `db:restore` script in
`package.json`, and no documented manual restore steps beyond what a
Supabase-side backup (if verified to exist) would itself provide.

## H. Storage Recovery

Production binary assets are stored separately from PostgreSQL, in Supabase
Storage. Known buckets:

- `media` — public product/category imagery (`src/lib/admin/media.ts`).
- `seller-verification` — private seller KYC/identity documents
  (`src/lib/seller-verification/storage.ts`).

**Restoring PostgreSQL alone does not restore these binary objects.**
Postgres holds only references and metadata (URL, filename, storage path);
the actual files live in Storage.

Recovery of these two surfaces must be treated separately:

- **Database metadata recovery** — recovering the `MediaAsset` /
  `SellerVerificationDocument` rows (paths, filenames, descriptive fields)
  is covered by §G, and only restores *references*, not files.
- **Storage object recovery** — recovering the actual binary files in the
  `media` and `seller-verification` buckets is a separate operation. **No
  Storage backup procedure is documented or verified to exist for this
  project.** Do not assume one is available.

## I. Configuration Recovery

- `.env.example` (tracked in Git) documents which configuration **keys** are
  required and which source system each comes from — it does not, and must
  not, contain actual secret values.
- Actual secrets are **not** stored in Git. `.env`, `.env.local`, and
  `.vercel/project.json` are all gitignored (confirmed in the audit).
- If Vercel's Production Environment Variables are lost, they must be
  **reconstructed from their respective source systems** — the Supabase
  dashboard (database connection strings, API keys), the email/SMTP
  provider's dashboard, and the PayMongo dashboard (test keys only; see
  §K for PayMongo dormancy verification) — using `.env.example` as the
  checklist of which keys are needed.
- Application-level configuration that lives in the database itself —
  `StoreSetting` rows (site description, shipping text, etc.) and
  `ContentPage` / `ContentBlock` CMS rows — is **not** recoverable from Git
  at all. It only exists in PostgreSQL, and is covered by database recovery
  (§G), not by this section.

No secret values are included in this document, and none should ever be
added to it.

## J. Schema / Migration Recovery

Document the architecture as it actually exists, verified in the audit:

- There is **no** `prisma/migrations/` directory — Prisma's native migration
  history mechanism is not used by this project.
- `prisma db push` is used to synchronize the Prisma-expressible parts of the
  schema (`prisma/schema.prisma`) directly to the database.
- `supabase/migrations/*.sql` contains raw, hand-authored SQL files for
  changes not expressible through `db push` alone (RLS policies, grants,
  constraints, and other DDL).
- These SQL files are applied manually, one at a time, using the project's
  existing mechanism: `node --env-file=.env scripts/apply-sql.mjs
  supabase/migrations/<file>.sql` (which wraps `prisma db execute`).
- **There is no `_prisma_migrations` tracking table** — confirmed absent
  from the live database. Nothing in this project records, automatically,
  which of the SQL files in `supabase/migrations/` have already been applied.
- Where a reversal is documented, it exists only as a **manual** SQL comment
  at the bottom of the individual migration file (not all files include
  one) — it is never automatically available or automatically run, and must
  be reviewed and executed by an operator by hand.

**When rebuilding a database/schema from this repository, the SQL files in
`supabase/migrations/` must be reviewed and applied in filename order**
(they are timestamp-prefixed) — this is not automated by `npm run db:push`
or any other script, and is not currently documented anywhere else in this
project.

This document does not change, execute, or reverse any migration.

## K. Post-Recovery Verification

After any recovery action, verify using the same baseline this project's
own promotion history has used:

**HTTP smoke tests** (expected status against `https://axiaro.shop`):

| Path | Expected |
| --- | --- |
| `/` | 200 |
| `/cart` | 200 |
| `/track` | 200 |
| `/account/orders` | 307 → login |
| `/admin/orders` | 307 → admin login |
| `/admin/returns` | 307 → admin login |
| `/seller` | 307 → seller login |
| `/admin/payments` | 307 → login |

**Reconciliation** (must report 0 fail):

```bash
npm run reconcile:payments
npm run reconcile:marketplace
```

**Business-data verification** — compare counts for `Order`, `SellerOrder`,
`Payment`, `PaymentRefund`, `ReturnRequest`, `Seller`, `SellerSettlement`,
and `Product` against the last recorded baseline (§L) via read-only queries
only.

Also verify:

- **PayMongo Production remains dormant** when it is supposed to be —
  zero `PAYMONGO_*` Production environment variables, and the webhook
  endpoint (`/api/webhooks/paymongo`) still responds `401` (fails closed).
- **No unexpected Production business data was created** during recovery —
  counts match §L (or the latest recorded baseline) exactly, with no new
  orders, payments, refunds, returns, or settlements.
- **No unexpected environment changes occurred** — Vercel Environment
  Variables and aliases (`axiaro.shop`, `www.axiaro.shop`,
  `shop.demo.noetikon.tech`) match their pre-incident state.

## L. Current Known Production Baseline

This is the **current verified baseline as of the latest recorded release**,
not a permanent constant. Before performing any recovery, the incident
operator must record the *actual latest* baseline from `docs/deployments.md`
and a fresh read-only count query — do not rely on this section if a newer
entry exists in `docs/deployments.md`.

- **Production commit:** `1f370a0`
- **Business-data counts:**
  - Order = 12
  - SellerOrder = 12
  - Payment = 2
  - PaymentRefund = 0
  - ReturnRequest = 0
  - Seller = 3
  - SellerSettlement = 0
  - Product = 38

## M. Incident Closure / Sign-Off

Every recovery action must close with a recorded sign-off containing:

- Incident date/time
- Incident classification (§C category)
- Affected components (application / database / Storage / configuration)
- Original deployment ID
- Original commit
- Recovery action taken
- Recovered deployment ID
- Recovered commit
- Database recovery point, if any (or "not applicable — application-only")
- Verification results (§K smoke tests)
- Reconciliation results (§K reconcile scripts)
- Final business-data counts
- PayMongo status
- Operator name / sign-off

Append this record to `docs/deployments.md` (or a dedicated incident log, if
one is created in a future task) so the next incident has an accurate
baseline to compare against.
