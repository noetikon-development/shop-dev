"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCw } from "lucide-react";
import { notify } from "@/components/admin/ui";
import { reprocessWebhookEventAction } from "@/lib/admin/payment-actions";

/**
 * 9F-54 — re-run a FAILED PayMongo webhook through the same idempotent handler
 * from its stored raw payload. `manage_payments` only (enforced in the action).
 * The handler is status-guarded, so this never creates a duplicate business
 * record; a genuine mismatch simply fails again.
 */
export function ReprocessWebhookButton({ webhookEventId }: { webhookEventId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await reprocessWebhookEventAction({ webhookEventId });
          if (res.ok) notify.success(res.message ?? "Reprocessed.");
          else notify.error(res.error ?? "That didn't work.");
          router.refresh();
        })
      }
      className="btn btn-outline py-1 text-xs"
    >
      {pending ? <Loader2 size={12} className="animate-spin" /> : <RotateCw size={12} />}
      Reprocess
    </button>
  );
}
