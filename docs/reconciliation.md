# Reconciliation — operator guide

Axiaro runs two active, business-critical reconciliation checks (payments,
marketplace) once a day, plus a daily watchdog — scheduled one hour later —
that catches the one failure mode the job itself can't detect: a run that
silently died mid-execution.

## 1. `ReconciliationRun` lifecycle

Every invocation — scheduled (CRON) or operator-triggered (MANUAL) — creates
one `ReconciliationRun` row before either check runs, and moves it to exactly
one terminal state:

```
RUNNING ──┬─→ PASS     (both checks clean)
          ├─→ WARN     (a check found something worth reviewing, not broken)
          ├─→ FAIL     (a check found a real mismatch)
          └─→ ERROR    (the job itself threw before producing a result —
                         reached the job's own or the cron route's catch —
                         OR the daily watchdog found the row still RUNNING
                         past the stale threshold and marked it ERROR itself)
```

`RUNNING → PASS/WARN/FAIL` and the job's own `RUNNING → ERROR` transition are
written by `src/lib/marketplace/reconciliation-job.ts` /
`src/lib/marketplace/reconciliation-run.ts`. The watchdog's
`RUNNING → ERROR` transition (§3) is written by
`src/lib/marketplace/reconciliation-watchdog.ts` — same terminal status, two
different sources; the row's `error` message text (and the alert that
accompanies it) tells you which one fired.

## 2. The daily reconciliation job and its two existing alerts

- **Schedule:** `30 9 * * *` (daily, 09:30 UTC) → `GET /api/cron/reconciliation`, unchanged by the watchdog work.
- **Completed WARN/FAIL alert** — `sendReconciliationAlertOps`, dedup key `RECONCILE_ALERT:<dateKey>`. Sent when the job *completes* and reports WARN or FAIL. Never sent for PASS.
- **Execution-failure alert** — `sendReconciliationFailureAlertOps`, dedup key `RECONCILE_FAILURE_ALERT:<dateKey>`. Sent when the job's own code throws and is caught (by `reconciliation-job.ts` or the cron route) before producing a PASS/WARN/FAIL result.

Both are dated per calendar day, because each is scoped to "did today's run have this outcome" — a second attempt on the same day would collide with, and correctly dedupe against, the first.

## 3. The stale-run watchdog (new)

**The gap these two alerts cannot cover:** if the Vercel function running the daily job is killed — a timeout, an out-of-memory kill, a deploy interrupting it mid-request — *before* either catch block above ever executes, the `ReconciliationRun` row is left at `RUNNING` forever, `completedAt` stays `null`, and neither alert fires. Nobody is told reconciliation didn't happen.

- **Schedule:** daily, `30 10 * * *` (10:30 UTC) → `GET /api/cron/reconciliation-watchdog` (`vercel.json`) — one hour after the reconciliation job's own 09:30 UTC schedule. Daily rather than more frequent because the current Vercel Hobby plan does not permit a sub-daily cron schedule; same-day detection is still the intended and achieved behavior, since the 30-minute stale threshold falls well inside that one-hour gap.
- **Scope:** `invocationSource = "CRON"` rows only. A `MANUAL` run (an operator's own CLI script or admin-triggered invocation) is **never** auto-flagged — a long-running manual session is not evidence of an infrastructure failure, and an operator watching their own terminal doesn't need a stale-run alert about it.
- **Stale threshold:** 30 minutes. The one historical run on record completed in well under one second; 30 minutes is comfortably longer than any plausible legitimate execution of this job (two read-only checks against current data volumes) and comfortably shorter than the 24-hour gap until the next scheduled run, so a stuck run is caught the same day it happens.
- **Detection query:** `WHERE invocationSource = "CRON" AND status = "RUNNING" AND startedAt < now() - 30 minutes`.
- **Transition:** each matching row is moved `RUNNING → ERROR` via a **guarded** update — `WHERE id = <runId> AND status = "RUNNING"` — never an unconditional one. Its `error` field is set to a clearly identifiable watchdog-authored message (`"Stale RUNNING row detected by watchdog after 30 minutes — reconciliation process likely terminated before completion."`), never a raw infrastructure error or secret.
- **Stale-run alert** — `sendReconciliationStaleRunAlertOps`, dedup key `RECONCILE_STALE_ALERT:<reconciliationRunId>`. Unlike the other two alerts, this is keyed by the specific run's own id, not by calendar day — so a repeated or retried watchdog invocation never re-alerts on a run it already handled, while a genuinely different stale run (a different id) always gets its own, independent alert even if it happens to fall on the same calendar day.
- **Audit logging:** exactly one `AdminAuditLog` row per transitioned run, `action: "reconciliation.stale_run_detected"`, with the run's id, invocation source, original `startedAt`, the watchdog's detection time, and the threshold in its `meta` — visible at `/admin/audit` alongside every other reconciliation audit entry.

### Why three separate dedup keys

| Alert | Key | Scoped by |
|---|---|---|
| Completed WARN/FAIL | `RECONCILE_ALERT:<dateKey>` | calendar day |
| Execution failure | `RECONCILE_FAILURE_ALERT:<dateKey>` | calendar day |
| Stale run (watchdog) | `RECONCILE_STALE_ALERT:<reconciliationRunId>` | the specific run |

The first two are naturally "once per day" events (the job runs once a day). The stale-run alert is keyed to the specific `ReconciliationRun.id` instead, so a repeated or retried watchdog invocation never re-alerts about the same already-handled stale run — while still guaranteeing a *different* stale run (a different id, possibly the very next day's run) is never suppressed by an unrelated key collision.

## 4. Concurrency

Every state transition in this system — the job's own and the watchdog's — uses a conditional (guarded) update scoped by the row's `id` and its expected current `status`, never a plain unconditional update. This means:
- If the real job finishes (to PASS/WARN/FAIL) or fails (to ERROR) in the window between the watchdog reading a row as stale and writing its own transition, the watchdog's guarded update matches 0 rows and does nothing — no alert, no audit log, no overwritten result.
- Two overlapping watchdog invocations racing on the same row: only one of them can win the guarded update; the other sees 0 rows affected and treats the row as already resolved.
- A row already in any terminal state is never reprocessed, because the watchdog's own selection query only ever looks at `status = "RUNNING"` rows in the first place.

## 5. Repeated stale runs — no aggregate escalation (for now)

Each distinct stale `ReconciliationRun.id` gets its own, independent alert. There is currently **no** "N stale runs in M days" or "no successful run for X hours" aggregate escalation — if the daily job stalls repeatedly, an operator will receive one stale-run alert per day, each clearly identifying its own run, but no additional "this keeps happening" summary. This has been explicitly deferred to a future task, not omitted by oversight.

## 6. No automatic recovery notification

There is no separate "reconciliation has recovered" email. A later `PASS`, `WARN`, or `FAIL` run completing normally (i.e., the daily job simply working again, with or without its own alert) is treated as sufficient recovery visibility.

## 7. Operational owner

**Axiaro Platform Operations** owns this alert and is expected to:
1. Investigate why the CRON execution terminated before completion — check the Vercel function logs for `/api/cron/reconciliation` around the `startedAt` time in the alert, looking for a timeout, an out-of-memory kill, or a deploy that interrupted it.
2. Confirm the next scheduled (09:30 UTC) reconciliation run completes normally — a fresh WARN/FAIL/PASS alert (or lack of one, for a clean PASS) the following day is the signal that it has.

No further escalation process exists beyond this — see §5.
