"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, XCircle } from "lucide-react";
import { Card, Modal, Select, notify } from "@/components/admin/ui";
import { orderStatusLabel } from "@/lib/orders/status";
import { updateOrderStatusAction, cancelOrderAction } from "@/lib/admin/order-actions";

export function OrderAdminActions({
  orderId,
  status,
  forwardStatuses,
  cancellable,
  canManage,
}: {
  orderId: string;
  status: string;
  /** Forward transitions offered in the dropdown (never includes CANCELLED). */
  forwardStatuses: string[];
  cancellable: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [target, setTarget] = useState(forwardStatuses[0] ?? "");
  const [note, setNote] = useState("");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [reason, setReason] = useState("");

  if (!canManage) {
    return (
      <Card className="text-sm text-ink-faint">
        Read-only — the <code className="text-ink-soft">manage_orders</code> permission is required
        to change status or cancel.
      </Card>
    );
  }

  function submitStatus() {
    if (!target) return;
    startTransition(async () => {
      const res = await updateOrderStatusAction({ orderId, to: target, note: note.trim() || undefined });
      if (res.ok) {
        notify.success(res.message ?? "Order updated.");
        setNote("");
        router.refresh();
      } else {
        notify.error(res.error ?? "Could not update the order.");
      }
    });
  }

  function submitCancel() {
    startTransition(async () => {
      const res = await cancelOrderAction({ orderId, reason: reason.trim() || undefined });
      if (res.ok) {
        notify.success(res.message ?? "Order cancelled.");
        setConfirmCancel(false);
        setReason("");
        router.refresh();
      } else {
        notify.error(res.error ?? "Could not cancel the order.");
      }
    });
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">Manage order</h2>

      {forwardStatuses.length > 0 ? (
        <div className="mt-3 space-y-3">
          <div className="space-y-1.5">
            <label htmlFor="order-next-status" className="block text-xs font-medium text-ink-soft">
              Move to
            </label>
            <Select
              id="order-next-status"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              disabled={pending}
            >
              {forwardStatuses.map((s) => (
                <option key={s} value={s}>
                  {orderStatusLabel(s)}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="order-status-note" className="block text-xs font-medium text-ink-soft">
              Note <span className="text-ink-faint">(optional, shown on the order timeline)</span>
            </label>
            <input
              id="order-status-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={300}
              className="field text-sm"
              placeholder="e.g. Handed to courier"
              disabled={pending}
            />
          </div>
          <button
            type="button"
            onClick={submitStatus}
            disabled={pending || !target}
            className="btn btn-primary w-full py-2 text-sm"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            Update status
          </button>
        </div>
      ) : (
        <p className="mt-2 text-sm text-ink-soft">
          No forward status change is available from{" "}
          <span className="font-medium text-ink">{orderStatusLabel(status)}</span>
          {status === "PENDING_PAYMENT" && " — the next step is payment, which isn’t enabled yet"}.
        </p>
      )}

      {cancellable && (
        <div className="mt-4 border-t border-line pt-4">
          <button
            type="button"
            onClick={() => setConfirmCancel(true)}
            disabled={pending}
            className="btn btn-outline w-full py-2 text-sm text-clay"
          >
            <XCircle size={14} /> Cancel order
          </button>
        </div>
      )}

      <Modal
        open={confirmCancel}
        onClose={() => !pending && setConfirmCancel(false)}
        size="sm"
        title="Cancel this order?"
        description="Any stock this order removed will be returned. This can’t be undone."
        footer={
          <>
            <button
              type="button"
              onClick={() => setConfirmCancel(false)}
              disabled={pending}
              className="btn btn-outline py-2 text-sm"
            >
              Keep order
            </button>
            <button
              type="button"
              onClick={submitCancel}
              disabled={pending}
              className="btn btn-clay py-2 text-sm text-paper"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Cancel order
            </button>
          </>
        }
      >
        <div className="space-y-1.5">
          <label htmlFor="order-cancel-reason" className="block text-xs font-medium text-ink-soft">
            Reason <span className="text-ink-faint">(optional, recorded on the order + audit log)</span>
          </label>
          <textarea
            id="order-cancel-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={300}
            rows={3}
            className="field text-sm"
            placeholder="e.g. Customer requested cancellation"
            disabled={pending}
          />
        </div>
      </Modal>
    </Card>
  );
}
