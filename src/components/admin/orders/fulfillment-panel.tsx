"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2, Truck } from "lucide-react";
import { Card, Modal, Select, FormField, notify } from "@/components/admin/ui";
import { formatDate } from "@/lib/utils";
import { COURIERS, courierLabel, isSafeTrackingUrl } from "@/lib/orders/couriers";
import {
  updateFulfillmentAction,
  markShippedAction,
  markOutForDeliveryAction,
  markDeliveredAction,
  type FulfillmentActionState,
} from "@/lib/admin/fulfillment-actions";

type Fulfillment = {
  orderId: string;
  status: string;
  storePickup: boolean;
  courier: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  fulfillmentNote: string | null;
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 text-sm">
      <dt className="shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 text-right text-ink">{children}</dd>
    </div>
  );
}

export function FulfillmentPanel({ f, canManage }: { f: Fulfillment; canManage: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [formOpen, setFormOpen] = useState<null | "ship" | "edit">(null);

  const hasInfo = Boolean(
    f.courier || f.trackingNumber || f.trackingUrl || f.shippedAt || f.deliveredAt || f.fulfillmentNote,
  );
  const safeUrl = f.trackingUrl && isSafeTrackingUrl(f.trackingUrl) ? f.trackingUrl : null;

  const preFulfilment = ["PENDING_PAYMENT", "PENDING", "PAID"].includes(f.status);
  const cancelled = f.status === "CANCELLED";

  function run(action: () => Promise<FulfillmentActionState>, closeForm = false) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        notify.success(res.message ?? "Done.");
        if (closeForm) setFormOpen(null);
        router.refresh();
      } else {
        const firstFieldError = res.fieldErrors && Object.values(res.fieldErrors)[0];
        notify.error(firstFieldError || res.error || "That didn’t work.");
      }
    });
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <Truck size={15} className="text-ink-faint" />
        <h2 className="text-sm font-semibold text-ink">Fulfilment</h2>
      </div>

      {f.storePickup && (
        <p className="mt-2 rounded-sm bg-surface-sunken px-2.5 py-1.5 text-xs text-ink-soft">
          Store pickup — no courier or tracking needed.
        </p>
      )}

      {hasInfo ? (
        <dl className="mt-3 space-y-2 border-t border-line pt-3">
          {f.courier && (
            <Row label="Courier">{courierLabel(f.courier, f.courierName)}</Row>
          )}
          {f.trackingNumber && (
            <Row label="Tracking #">
              <span className="font-mono">{f.trackingNumber}</span>
            </Row>
          )}
          {safeUrl && (
            <Row label="Tracking link">
              <a
                href={safeUrl}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="inline-flex items-center gap-1 text-clay hover:underline"
              >
                Open <ExternalLink size={12} />
              </a>
            </Row>
          )}
          {f.shippedAt && <Row label="Shipped">{formatDate(f.shippedAt, { hour: "numeric", minute: "2-digit" })}</Row>}
          {f.deliveredAt && <Row label="Delivered">{formatDate(f.deliveredAt, { hour: "numeric", minute: "2-digit" })}</Row>}
          {f.fulfillmentNote && (
            <div className="text-sm">
              <dt className="text-ink-faint">Internal note</dt>
              <dd className="mt-0.5 text-ink-soft">{f.fulfillmentNote}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="mt-3 border-t border-line pt-3 text-sm text-ink-faint">
          {cancelled
            ? "This order was cancelled."
            : preFulfilment
              ? "Fulfilment opens once the order is being prepared."
              : "No courier or tracking added yet."}
        </p>
      )}

      {canManage && !cancelled && !preFulfilment && (
        <div className="mt-4 space-y-2 border-t border-line pt-4">
          {f.status === "PROCESSING" && !f.storePickup && (
            <button
              type="button"
              onClick={() => setFormOpen("ship")}
              disabled={pending}
              className="btn btn-primary w-full py-2 text-sm"
            >
              Mark as shipped
            </button>
          )}
          {f.status === "PROCESSING" && f.storePickup && (
            <button
              type="button"
              onClick={() => run(() => markDeliveredAction({ orderId: f.orderId }))}
              disabled={pending}
              className="btn btn-primary w-full py-2 text-sm"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Mark as collected
            </button>
          )}
          {f.status === "SHIPPED" && (
            <button
              type="button"
              onClick={() => run(() => markOutForDeliveryAction({ orderId: f.orderId }))}
              disabled={pending}
              className="btn btn-outline w-full py-2 text-sm"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Mark out for delivery
            </button>
          )}
          {(f.status === "SHIPPED" || f.status === "OUT_FOR_DELIVERY") && (
            <button
              type="button"
              onClick={() => run(() => markDeliveredAction({ orderId: f.orderId }))}
              disabled={pending}
              className="btn btn-primary w-full py-2 text-sm"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Mark as delivered
            </button>
          )}
          {!f.storePickup && (
            <button
              type="button"
              onClick={() => setFormOpen("edit")}
              disabled={pending}
              className="btn btn-ghost w-full py-2 text-sm"
            >
              {f.status === "PROCESSING" ? "Add courier / tracking" : "Edit courier / tracking"}
            </button>
          )}
        </div>
      )}

      {formOpen && (
        <FulfillmentForm
          mode={formOpen}
          f={f}
          pending={pending}
          onClose={() => setFormOpen(null)}
          onSubmit={(payload) =>
            run(
              () =>
                formOpen === "ship"
                  ? markShippedAction({ orderId: f.orderId, ...payload })
                  : updateFulfillmentAction({ orderId: f.orderId, ...payload }),
              true,
            )
          }
        />
      )}
    </Card>
  );
}

function FulfillmentForm({
  mode,
  f,
  pending,
  onClose,
  onSubmit,
}: {
  mode: "ship" | "edit";
  f: Fulfillment;
  pending: boolean;
  onClose: () => void;
  onSubmit: (payload: {
    courier: string;
    courierName: string;
    trackingNumber: string;
    trackingUrl: string;
    fulfillmentNote?: string;
    note?: string;
  }) => void;
}) {
  const [courier, setCourier] = useState(f.courier ?? "");
  const [courierName, setCourierName] = useState(f.courierName ?? "");
  const [trackingNumber, setTrackingNumber] = useState(f.trackingNumber ?? "");
  const [trackingUrl, setTrackingUrl] = useState(f.trackingUrl ?? "");
  const [internalNote, setInternalNote] = useState(f.fulfillmentNote ?? "");
  const [timelineNote, setTimelineNote] = useState("");

  return (
    <Modal
      open
      onClose={() => !pending && onClose()}
      title={mode === "ship" ? "Mark order as shipped" : "Edit courier / tracking"}
      description={
        mode === "ship"
          ? "The order moves to Shipped and the customer sees the courier + tracking."
          : "Update the courier and tracking. The order status does not change."
      }
      footer={
        <>
          <button type="button" onClick={onClose} disabled={pending} className="btn btn-outline py-2 text-sm">
            Cancel
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              onSubmit(
                mode === "ship"
                  ? {
                      courier,
                      courierName,
                      trackingNumber,
                      trackingUrl,
                      note: timelineNote.trim() || undefined,
                    }
                  : {
                      courier,
                      courierName,
                      trackingNumber,
                      trackingUrl,
                      fulfillmentNote: internalNote.trim() || undefined,
                    },
              )
            }
            className="btn btn-primary py-2 text-sm"
          >
            {pending && <Loader2 size={14} className="animate-spin" />}
            {mode === "ship" ? "Mark shipped" : "Save"}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField label="Courier" htmlFor="ff-courier">
          <Select id="ff-courier" value={courier} onChange={(e) => setCourier(e.target.value)}>
            <option value="">Select a courier…</option>
            {COURIERS.filter((c) => c.code !== "PICKUP").map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>

        {courier === "OTHER" && (
          <FormField label="Courier name" htmlFor="ff-courier-name">
            <input
              id="ff-courier-name"
              value={courierName}
              onChange={(e) => setCourierName(e.target.value)}
              maxLength={60}
              className="field text-sm"
              placeholder="e.g. Grab Express"
            />
          </FormField>
        )}

        <FormField label="Tracking number" htmlFor="ff-tracking">
          <input
            id="ff-tracking"
            value={trackingNumber}
            onChange={(e) => setTrackingNumber(e.target.value)}
            maxLength={40}
            className="field font-mono text-sm"
            placeholder="e.g. JT0001234567"
          />
        </FormField>

        <FormField
          label="Tracking URL"
          htmlFor="ff-url"
          hint="Optional. Leave blank to auto-build from the courier where supported. Must be https://"
        >
          <input
            id="ff-url"
            type="url"
            value={trackingUrl}
            onChange={(e) => setTrackingUrl(e.target.value)}
            maxLength={500}
            className="field text-sm"
            placeholder="https://…"
          />
        </FormField>

        {mode === "ship" ? (
          <FormField label="Timeline note" htmlFor="ff-note" hint="Optional, shown to the customer on the order timeline.">
            <input
              id="ff-note"
              value={timelineNote}
              onChange={(e) => setTimelineNote(e.target.value)}
              maxLength={300}
              className="field text-sm"
              placeholder="e.g. Dispatched from Batangas hub"
            />
          </FormField>
        ) : (
          <FormField label="Internal note" htmlFor="ff-internal" hint="Only visible to admins — never shown to the customer.">
            <textarea
              id="ff-internal"
              value={internalNote}
              onChange={(e) => setInternalNote(e.target.value)}
              maxLength={500}
              rows={2}
              className="field text-sm"
            />
          </FormField>
        )}
      </div>
    </Modal>
  );
}
