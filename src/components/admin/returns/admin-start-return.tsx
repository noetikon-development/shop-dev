"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw } from "lucide-react";
import { Card, Select, notify } from "@/components/admin/ui";
import { RETURN_REASONS, RETURN_REASON_LABEL } from "@/lib/returns/status";
import { adminCreateReturnAction } from "@/lib/admin/returns-actions";

type Line = { orderItemId: string; name: string; variantLabel: string | null; remaining: number };

export function AdminStartReturn({
  orderId,
  orderNumber,
  orderStatus,
  openReturnNumber,
  lines,
}: {
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  openReturnNumber: string | null;
  lines: Line[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [qty, setQty] = useState<Record<string, number>>(
    Object.fromEntries(lines.map((l) => [l.orderItemId, 0])),
  );

  if (openReturnNumber) {
    return (
      <Card className="text-sm text-ink-soft">
        This order has an open return.{" "}
        <Link href={`/admin/returns`} className="text-ink hover:underline">
          View returns
        </Link>
        .
      </Card>
    );
  }

  if (lines.length === 0) {
    return (
      <Card className="text-sm text-ink-faint">
        No lines on this order still have returnable quantity.
      </Card>
    );
  }

  const selected = Object.entries(qty).filter(([, n]) => n > 0);

  return (
    <Card>
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <RotateCcw size={15} /> Start a return (assisted)
        </h2>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="btn btn-outline py-1.5 text-sm"
          >
            New return
          </button>
        )}
      </div>

      {orderStatus !== "DELIVERED" && (
        <p className="mt-2 text-xs text-clay">
          This order is {orderStatus}, not delivered — creating a return here will be recorded as an
          override.
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-3">
          <div className="overflow-hidden rounded-sm border border-line">
            {lines.map((l) => (
              <div
                key={l.orderItemId}
                className="flex items-center justify-between gap-3 border-b border-line p-3 last:border-0"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium">{l.name}</p>
                  {l.variantLabel && <p className="text-xs text-ink-faint">{l.variantLabel}</p>}
                  <p className="text-xs text-ink-faint">up to {l.remaining} returnable</p>
                </div>
                <input
                  type="number"
                  min={0}
                  max={l.remaining}
                  value={qty[l.orderItemId] ?? 0}
                  disabled={pending}
                  onChange={(e) =>
                    setQty((q) => ({
                      ...q,
                      [l.orderItemId]: Math.max(0, Math.min(l.remaining, Number(e.target.value) || 0)),
                    }))
                  }
                  className="field w-20"
                />
              </div>
            ))}
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-ink-soft">Reason</label>
            <Select value={reason} onChange={(e) => setReason(e.target.value)} disabled={pending}>
              <option value="">Choose…</option>
              {RETURN_REASONS.map((r) => (
                <option key={r} value={r}>
                  {RETURN_REASON_LABEL[r]}
                </option>
              ))}
            </Select>
          </div>

          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-ink-soft">
              Internal note <span className="text-ink-faint">(optional)</span>
            </label>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              className="field text-sm"
              disabled={pending}
            />
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="btn btn-outline flex-1 py-2 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending || selected.length === 0 || !reason}
              onClick={() =>
                start(async () => {
                  const res = await adminCreateReturnAction({
                    orderId,
                    reason,
                    staffNote: note.trim() || undefined,
                    lines: selected.map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
                  });
                  if (res.ok) {
                    notify.success(res.message ?? "Return created.");
                    if (res.returnId) router.push(`/admin/returns/${res.returnId}`);
                    else router.refresh();
                  } else {
                    notify.error(res.error ?? "Could not create the return.");
                  }
                })
              }
              className="btn btn-primary flex-1 py-2 text-sm"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Create return
            </button>
          </div>
          <p className="text-xs text-ink-faint">
            The customer will get the same &ldquo;return requested&rdquo; email as a self-service
            return. Order {orderNumber} is not modified.
          </p>
        </div>
      )}
    </Card>
  );
}
