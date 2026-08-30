"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requirePermission } from "@/lib/admin/rbac";
import { writeAudit } from "@/lib/admin/audit";
import { retryEmailByLog } from "@/lib/email/notifications";

/**
 * Retry a FAILED / SKIPPED transactional email (Step 17). Gated on the existing
 * `view_audit_logs` permission — the same permission that lets an admin see the
 * email log at all. The retry re-runs the matching notification, reusing the
 * original idempotency key so it can never produce a duplicate send.
 */

export type EmailLogActionState = { ok?: boolean; error?: string; message?: string };

const schema = z.object({ id: z.string().min(1).max(64) });

export async function retryEmailLogAction(input: unknown): Promise<EmailLogActionState> {
  const admin = await requirePermission("view_audit_logs");

  const parsed = schema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Invalid request." };

  const result = await retryEmailByLog(parsed.data.id);

  await writeAudit({
    actorUserId: admin.user.id,
    action: "email.retry",
    targetType: "email_log",
    targetId: parsed.data.id,
    summary: `${admin.user.email} retried an email (${result.status.toLowerCase()})`,
    meta: { status: result.status, deduped: Boolean(result.deduped) },
  });

  revalidatePath("/admin/email");

  if (result.status === "SENT") return { ok: true, message: "Email re-sent." };
  if (result.status === "SKIPPED") return { ok: true, message: "Recorded — no email provider is configured." };
  if (result.status === "DEDUPED") return { ok: true, message: "Already sent — nothing to do." };
  return { ok: false, error: result.error ? `Retry failed: ${result.error}` : "Retry failed." };
}
