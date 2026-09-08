"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { customerCancelOrderAction } from "@/lib/account/order-actions";
import { buttonClasses } from "@/components/ui/button";

/**
 * 9F-30D — customer self-service order cancellation. Rendered on the account
 * order detail page only while `Order.status` is PENDING_PAYMENT / PENDING /
 * PROCESSING (the page decides via `isCancellable`; the server action re-checks).
 *
 * A confirmation dialog spells out that cancellation can't be undone before the
 * request is sent. The reason field is optional — the schema needs nothing more.
 */
export function CustomerCancelOrder({ orderNumber }: { orderNumber: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [pending, setPending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !pending && setOpen(false);
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, pending]);

  async function confirm() {
    setPending(true);
    const res = await customerCancelOrderAction({ orderNumber, reason: reason.trim() });
    setPending(false);
    if (res.ok) {
      toast.success(res.message ?? "Order cancelled.");
      setOpen(false);
      setReason("");
      router.refresh();
    } else {
      toast.error(res.error ?? "That didn't work.");
    }
  }

  return (
    <div className="card-surface flex flex-wrap items-center justify-between gap-3 p-5">
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-ink-soft" />
        <div>
          <p className="text-sm font-medium">Need to cancel this order?</p>
          <p className="text-sm text-ink-soft">
            You can cancel while it hasn&apos;t shipped yet. Once it&apos;s on the way, request a
            return instead.
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={buttonClasses({ variant: "outline", size: "sm" })}
      >
        Cancel order
      </button>

      {open && (
        <div className="fixed inset-0 z-[70] flex items-end justify-center p-0 sm:items-center sm:p-6">
          <div
            className="absolute inset-0 bg-ink/40 backdrop-blur-[2px]"
            onClick={() => !pending && setOpen(false)}
            aria-hidden
          />
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="cancel-order-title"
            tabIndex={-1}
            className="relative w-full max-w-md rounded-t-lg bg-paper p-5 shadow-pop outline-none sm:rounded-lg"
          >
            <h2 id="cancel-order-title" className="flex items-center gap-2 text-base font-semibold">
              <AlertTriangle size={16} className="text-clay" />
              Cancel order {orderNumber}?
            </h2>
            <p className="mt-2 text-sm text-ink-soft">
              This cancels your whole order and <strong>can&apos;t be undone</strong>. The items are
              released back to stock. If you paid on delivery there&apos;s nothing to refund; nothing
              is collected.
            </p>

            <label className="mt-4 block text-sm">
              <span className="mb-1 block font-medium">Reason <span className="text-ink-faint">(optional)</span></span>
              <textarea
                name="reason"
                rows={3}
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Let us know why (optional)"
                className="w-full rounded-sm border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-ink"
              />
            </label>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                disabled={pending}
                className={buttonClasses({ variant: "outline", size: "sm" })}
              >
                Keep order
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={pending}
                className={buttonClasses({ variant: "clay", size: "sm" })}
              >
                {pending && <Loader2 size={14} className="animate-spin" />}
                Cancel order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
