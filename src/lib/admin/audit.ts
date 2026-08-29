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
 */
export async function writeAudit(input: AuditInput): Promise<void> {
  try {
    await prisma.adminAuditLog.create({
      data: {
        actorUserId: input.actorUserId ?? null,
        action: input.action,
        targetType: input.targetType ?? null,
        targetId: input.targetId ?? null,
        summary: input.summary ?? null,
        meta: JSON.stringify(input.meta ?? {}),
      },
    });
  } catch (err) {
    console.error("[audit] failed to record", input.action, err);
  }
}
