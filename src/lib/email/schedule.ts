import "server-only";
import { after } from "next/server";

/**
 * Fire a transactional email AFTER the current response is sent, so the customer
 * / admin is never blocked waiting on an SMTP provider (Step 17 §16 / §30).
 *
 * The business transaction that triggered the email has already committed by the
 * time this runs — a delivery failure is logged (in EmailLog + console) and
 * never propagates back. `dispatchEmail` itself is already idempotent and
 * non-throwing; this adds a second guard and moves the work off the hot path.
 */
export function scheduleEmail(run: () => Promise<unknown>): void {
  const guarded = async () => {
    try {
      await run();
    } catch (err) {
      console.error("[email] scheduled dispatch failed", err);
    }
  };

  try {
    after(guarded);
  } catch {
    // `after()` is only usable within a request scope. Outside one (a script, a
    // test), fall back to a detached best-effort call.
    void guarded();
  }
}
