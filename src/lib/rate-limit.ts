import "server-only";
import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";

/**
 * Minimal fixed-window rate limiter (Step 21 P5).
 *
 * Backed by the `RateHit` table — one row per limit key, holding a hit `count`
 * and the `windowStart` it applies to. A hit that arrives after the window has
 * elapsed resets the row. The stored key is a salted SHA-256 hash: no raw IP,
 * email or other identifier is ever written.
 *
 * Design notes:
 *  - This is spam/abuse friction for unauthenticated endpoints, not a security
 *    control. It runs against the app's own Postgres and adds one short
 *    transaction per call.
 *  - It FAILS OPEN: any database error is logged and treated as "allowed", so a
 *    limiter outage can never take a public form offline.
 *  - It never throws.
 */

export type RateLimitResult = {
  ok: boolean;
  /** Hits still allowed in the current window (0 when blocked). */
  remaining: number;
  /** Seconds until the window resets — only meaningful when `ok` is false. */
  retryAfterSec: number;
};

const KEY_SALT = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "axiaro-rate-limit";

function hashKey(rawKey: string): string {
  return "rl:" + createHash("sha256").update(`${KEY_SALT}:${rawKey}`).digest("hex").slice(0, 48);
}

/**
 * Record a hit against `rawKey` and report whether it is within `limit` per
 * `windowMs`. Call exactly once per protected event.
 */
export async function hitRateLimit(
  rawKey: string,
  { limit, windowMs }: { limit: number; windowMs: number },
): Promise<RateLimitResult> {
  const key = hashKey(rawKey);
  const now = new Date();
  const windowFloor = new Date(now.getTime() - windowMs);

  try {
    return await prisma.$transaction(async (tx) => {
      const row = await tx.rateHit.findUnique({ where: { key } });

      // No row, or the previous window has fully elapsed → start a fresh window.
      if (!row || row.windowStart < windowFloor) {
        await tx.rateHit.upsert({
          where: { key },
          create: { key, count: 1, windowStart: now },
          update: { count: 1, windowStart: now },
        });
        return { ok: true, remaining: Math.max(0, limit - 1), retryAfterSec: 0 };
      }

      if (row.count < limit) {
        await tx.rateHit.update({ where: { key }, data: { count: { increment: 1 } } });
        return { ok: true, remaining: Math.max(0, limit - row.count - 1), retryAfterSec: 0 };
      }

      const retryAfterSec = Math.max(
        1,
        Math.ceil((row.windowStart.getTime() + windowMs - now.getTime()) / 1000),
      );
      return { ok: false, remaining: 0, retryAfterSec };
    });
  } catch (err) {
    console.error("[rate-limit] check failed — allowing", err);
    return { ok: true, remaining: limit, retryAfterSec: 0 };
  }
}

/**
 * Best-effort cleanup of rows whose window ended more than `olderThanMs` ago.
 * Safe to call opportunistically; never throws.
 */
export async function pruneRateHits(olderThanMs = 24 * 60 * 60 * 1000): Promise<void> {
  try {
    await prisma.rateHit.deleteMany({
      where: { windowStart: { lt: new Date(Date.now() - olderThanMs) } },
    });
  } catch (err) {
    console.error("[rate-limit] prune failed", err);
  }
}
