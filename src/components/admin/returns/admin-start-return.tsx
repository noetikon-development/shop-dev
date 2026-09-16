"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import { Card, Select, StatusBadge, notify } from "@/components/admin/ui";
import { RETURN_REASONS, RETURN_REASON_LABEL } from "@/lib/returns/status";
import { adminCreateReturnAction } from "@/lib/admin/returns-actions";

/**
 * Per-line delivery state is computed once, server-side, by
 * `orderReturnableLines()` (which itself reuses `orderItemDeliveryState` /
 * `withinReturnWindow` — the exact same rules `returnEligibility()` and the
 * create action's own override computation already use). This component only
 * ever DISPLAYS `naturallyEligible` — it never recomputes eligibility, and
 * selecting an ineligible line remains fully possible (the existing admin
 * override capability), just visibly flagged.
 */
type Line = {
  orderItemId: string;
  name: string;
  variantLabel: string | null;
  remaining: number;
  sellerName: string | null;
  naturallyEligible: boolean;
  deliveredAtLabel: string | null;
  daysRemaining: number | null;
};

export function AdminStartReturn({
  orderId,
  orderNumber,
  openReturnNumber,
  lines,
}: {
  orderId: string;
  orderNumber: string;
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

  const selectedLines = lines.filter((l) => (qty[l.orderItemId] ?? 0) > 0);
  const anyIneligibleOnOrder = lines.some((l) => !l.naturallyEligible);
  const selectionRequiresOverride = selectedLines.some((l) => !l.naturallyEligible);

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

      {anyIneligibleOnOrder && (
        <p className="mt-2 text-xs text-ink-faint">
          Only items whose seller has delivered are naturally eligible for return. On a multi-seller
          order, another seller&apos;s items may not be eligible yet — selecting one records this
          return as an override.
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-3">
          {selectionRequiresOverride && (
            <div className="flex items-start gap-2 rounded-sm bg-clay-50 px-3 py-2 text-xs text-clay">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>
                {selectedLines.filter((l) => !l.naturallyEligible).length === 1
                  ? "One selected item hasn't been delivered yet."
                  : `${selectedLines.filter((l) => !l.naturallyEligible).length} selected items haven't been delivered yet.`}{" "}
                Creating this return will be recorded as an override.
              </span>
            </div>
          )}
          <div className="overflow-hidden rounded-sm border border-line">
            {lines.map((l) => (
              <div
                key={l.orderItemId}
                className="flex items-center justify-between gap-3 border-b border-line p-3 last:border-0"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-sm font-medium">{l.name}</p>
                    <StatusBadge tone={l.naturallyEligible ? "success" : "warning"}>
                      {l.naturallyEligible
                        ? "Eligible"
                        : l.deliveredAtLabel
                          ? "Return window passed"
                          : "Not yet delivered"}
                    </StatusBadge>
                  </div>
                  {l.variantLabel && <p className="text-xs text-ink-faint">{l.variantLabel}</p>}
                  {l.sellerName && <p className="text-xs text-ink-faint">Seller: {l.sellerName}</p>}
                  <p className="text-xs text-ink-faint">
                    up to {l.remaining} returnable
                    {l.deliveredAtLabel && (
                      <>
                        {" · Delivered "}
                        {l.deliveredAtLabel}
                        {l.daysRemaining !== null &&
                          (l.daysRemaining >= 0
                            ? `, ${l.daysRemaining} day${l.daysRemaining === 1 ? "" : "s"} left to return`
                            : ", return window passed")}
                      </>
                    )}
                  </p>
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
              disabled={pending || selectedLines.length === 0 || !reason}
              onClick={() =>
                start(async () => {
                  const res = await adminCreateReturnAction({
                    orderId,
                    reason,
                    staffNote: note.trim() || undefined,
                    lines: selectedLines.map((l) => ({ orderItemId: l.orderItemId, quantity: qty[l.orderItemId] ?? 0 })),
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
