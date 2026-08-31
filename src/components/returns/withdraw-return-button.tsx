"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cancelReturnAction } from "@/lib/returns-actions";

export function WithdrawReturnButton({ returnNumber }: { returnNumber: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await cancelReturnAction({ returnNumber });
          if (res.ok) {
            toast.success("Return request withdrawn");
            router.refresh();
          } else {
            toast.error(res.error ?? "That didn't work.");
          }
        })
      }
      className="btn btn-outline"
    >
      {pending && <Loader2 size={14} className="animate-spin" />}
      Withdraw request
    </button>
  );
}
