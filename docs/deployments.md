# Axiaro Production Deployment Log

## Purpose

Vercel deployments for this project are performed through the local Vercel
CLI (`vercel deploy --prod`), not through a GitHub-integrated auto-deploy
pipeline. As a result, **Vercel's own deployment metadata does not reliably
expose the Git commit SHA a given deployment was built from** (confirmed in
the 2026-09-17 Backup & Recovery Readiness Audit — `vercel inspect` on a
Production deployment returns no commit/SHA field).

This file is therefore the **authoritative, project-maintained mapping**
between a Git commit and the Vercel Production deployment it produced. It
exists because nothing else in this project's tooling records that mapping.

## How to use this file

- **Append** a new entry after every Production promotion. Do not edit or
  remove existing entries — this is an append-only log.
- Before recovery (see `docs/recovery-runbook.md`), consult the most recent
  entry here to identify the current Production commit and deployment ID,
  and the entry before it to identify the last known-good state if the most
  recent one is the one being rolled back.
- Do not invent or backfill historical entries that were not actually
  verified at the time of that deployment — an incomplete log is more
  trustworthy than a fabricated one.

## Using the deployment helper

`scripts/deploy-production.mjs` wraps the exact same Production deployment
command this log already documents (`vercel deploy --prod --yes --scope
noetikon-technologies`) — it does not change the deployment mechanism. It
adds Git SHA capture, working-tree safety checks, and automatic recording
into this file.

Normal workflow:

1. Make/verify the intended commit is checked out.
2. Deploy and verify through the helper:
   ```bash
   node scripts/deploy-production.mjs --prod
   ```
3. The helper captures the current Git SHA, runs the deployment, waits for
   the Vercel CLI's own JSON result, and — **only if that result reports
   `readyState === "READY"`** — appends one new entry to this file below,
   using the deployment ID and URL returned by the CLI. It never rewrites,
   reorders, or removes an existing entry.

If the deployment does not reach `READY`, or its result cannot be parsed,
the helper exits non-zero and this file is left untouched.

Before running for real, `node scripts/deploy-production.mjs --dry-run`
shows the Git safety check result, the exact Vercel command that would run,
and the log entry that would be appended — without deploying anything or
writing to this file.

## Entry format

```
### YYYY-MM-DD — <short description>

- Environment: Production
- Domain: axiaro.shop
- Commit: <git sha>
- Deployment ID: <vercel dpl_… id>
- Status: <READY | other>
- Deployment URL: <vercel deployment url>
- Notes: <what changed, why, anything operationally relevant>
```

## Log

### 2026-09-17 — COD payment reconciliation visibility

- Environment: Production
- Domain: axiaro.shop
- Commit: `1f370a0`
- Deployment ID: `dpl_8Lq5UdaZ5AHhhUS3C4Pam8mccQmz`
- Status: READY
- Notes: COD payment reconciliation visibility update
  (`listUnconfirmedCodDeliveries()` banner on `/admin/payments`) and its
  related 9F-43B regression-test false-positive correction. Content-only
  precursor work on this same branch (About page / marketplace positioning
  copy) was promoted at commit `be7545d`, `dpl_HVv4SPq2yTBCpazTLdQ7uUz17f42`,
  immediately prior to this entry.

### 2026-09-21 — automated deployment via deploy-production.mjs

- Environment: Production
- Domain: axiaro.shop
- Commit: `d9e7d7cab91d9032954d3c991c0741ca86ca78c6`
- Deployment ID: `dpl_DqLE7GCG2UiArcLo7nVZamVp3suQ`
- Status: READY
- Deployment URL: https://shop-n9tkzzvbe-noetikon-technologies.vercel.app
- Notes: Deployed via scripts/deploy-production.mjs.

### 2026-09-21 — automated deployment via deploy-production.mjs

- Environment: Production
- Domain: axiaro.shop
- Commit: `1359f7e239f804d1bb694dcaa97646f6ccda68c5`
- Deployment ID: `dpl_GdhAJXUz1wDp5HrrJeEDfcSVxEkB`
- Status: READY
- Deployment URL: https://shop-96w2odzw3-noetikon-technologies.vercel.app
- Notes: Deployed via scripts/deploy-production.mjs.
