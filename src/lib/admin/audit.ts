import "server-only";
import { prisma } from "@/lib/prisma";

export type AuditInput = {
  actorUserId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  summary?: string | null;
  meta?: Record<string, unknown>;
};

/**
 * Append one entry to the admin audit trail. Best-effort: a logging failure must
 * never abort the operation being logged.
 *
 * Returns the created row's id (or `null` on failure) so a caller can use that
 * id as an immutable anchor for something else — e.g. a seller lifecycle email's
 * idempotency key, which must identify THIS specific transition and never
 * collide with a later, unrelated edit to the same row (9F-6b).
 */
export async function writeAudit(input: AuditInput): Promise<string | null> {
  try {
    const row = await prisma.adminAuditLog.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        summary: input.summary ?? null,
        meta: JSON.stringify(input.meta ?? {}),
      },
      select: { id: true },
    });
    return row.id;
  } catch (err) {
    console.error("[audit] failed to record", input.action, err);
    return null;
  }
}
