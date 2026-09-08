"use client";

import { useEffect, useState } from "react";
import { Loader2, AlertTriangle } from "lucide-react";
import {
  sellerCancelOrderAction,
  type SellerOrderActionState,
} from "@/lib/seller/order-actions";
import { Modal, notify, usePersistentAction } from "@/components/seller/ui";

/**
 * 9F-30B — the owning 3P seller declines (PENDING_PAYMENT) or cancels
 * (PROCESSING) an order they can't fulfil. A reason is mandatory, and the
 * consequence is spelled out before the confirm button: this cancels the
 * customer's WHOLE order, returns the stock, and can't be undone.
 *
 * Rendered independently of the fulfilment panel — a PENDING_PAYMENT order is
 * not yet "fulfillable" but can still be declined.
 */
export function SellerOrderCancelPanel({
  sellerOrderId,
  labels,
}: {
  sellerOrderId: string;
  labels: { button: string; done: string };
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const form = usePersistentAction<SellerOrderActionState>(sellerCancelOrderAction, {});

  useEffect(() => {
    if (form.state.ok) {
      if (form.state.message) notify.success(form.state.message);
      setOpen(false);
      setReason("");
    }
    if (form.state.error) notify.error(form.state.error);
  }, [form.state]);

  const submit = () => {
    const fd = new FormData();
    fd.set("sellerOrderId", sellerOrderId);
    fd.set("reason", reason.trim());
    form.dispatch(fd);
  };

  const reasonTooShort = reason.trim().length === 0;

  return (
    <>
      <p className="mb-3 text-sm text-ink-soft">
        Can’t fulfil this order? {labels.button === "Decline order" ? "Decline it" : "Cancel it"} and
        the customer’s whole order is cancelled — the items go back to your stock and the customer is
        notified. This can’t be undone.
      </p>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="btn btn-outline py-2 text-sm text-clay"
      >
        {labels.button}
      </button>

      <Modal
        open={open}
        onClose={() => (form.pending ? undefined : setOpen(false))}
        size="sm"
        title={
          <span className="flex items-center gap-2">
            <AlertTriangle size={16} className="text-clay" />
            {labels.button}
          </span>
        }
      >
        <div className="space-y-3">
          <div className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">
            <p className="font-medium">This cancels the customer’s entire order.</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
              <li>The order is marked cancelled and can’t be reopened.</li>
              <li>Every item on it goes back to your stock.</li>
              <li>The customer is emailed that their order was cancelled.</li>
              <li>Any commission on the order is reversed.</li>
            </ul>
          </div>

          <label className="block text-sm">
            <span className="mb-1 block font-medium text-ink">
              Reason <span className="text-clay">*</span>
            </span>
            <textarea
              name="reason"
              required
              maxLength={300}
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Tell Axiaro and the customer why you can’t fulfil this order."
              className="field w-full text-sm"
            />
            <span className="mt-1 block text-xs text-ink-faint">
              Shared with Axiaro Operations and recorded on the order. {reason.trim().length}/300
            </span>
          </label>

          {form.state.error && (
            <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{form.state.error}</p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={form.pending}
              className="btn btn-outline py-2 text-sm"
            >
              Keep order
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={form.pending || reasonTooShort}
              className="btn btn-clay py-2 text-sm text-paper"
            >
              {form.pending && <Loader2 size={14} className="animate-spin" />}
              {labels.button}
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
