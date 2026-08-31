"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { notify } from "@/components/admin/ui";
import { reconcilePaymentAction } from "@/lib/admin/payment-actions";

export function ReconcilePaymentButton({ paymentId }: { paymentId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await reconcilePaymentAction({ paymentId });
          if (res.ok) notify.success(res.message ?? "Checked with PayMongo.");
          else notify.error(res.error ?? "That didn't work.");
          router.refresh();
        })
      }
      className="btn btn-outline py-1.5 text-xs"
    >
      {pending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
      Re-check with PayMongo
    </button>
  );
}
