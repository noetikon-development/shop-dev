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

## Entry format

```
### YYYY-MM-DD — <short description>

- Environment: Production
- Domain: axiaro.shop
- Commit: <git sha>
- Deployment ID: <vercel dpl_… id>
- Status: <READY | other>
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
