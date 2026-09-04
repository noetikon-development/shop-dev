"use client";

import { useEffect, useState } from "react";
import { Loader2, Truck, ExternalLink } from "lucide-react";
import {
  advanceSellerOrderAction,
  saveShipmentAction,
  type SellerOrderActionState,
} from "@/lib/seller/order-actions";
import { FormField, Select, Modal, notify, usePersistentAction } from "@/components/seller/ui";
import { sellerOrderStatusLabel } from "@/lib/marketplace/seller-order-status";
import { COURIERS } from "@/lib/orders/couriers";

type ShipmentView = {
  id: string;
  carrier: string | null;
  carrierName: string | null;
  carrierLabel: string;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string;
  note: string | null;
} | null;

const SHIP_CARRIERS = COURIERS.filter((c) => c.code !== "PICKUP");

export function OrderFulfillmentPanel({
  sellerOrderId,
  status,
  allowedMoves,
  shipment,
}: {
  sellerOrderId: string;
  status: string;
  allowedMoves: string[];
  shipment: ShipmentView;
}) {
  const advance = usePersistentAction<SellerOrderActionState>(advanceSellerOrderAction, {});
  const [shipmentOpen, setShipmentOpen] = useState(false);

  useEffect(() => {
    if (advance.state.ok && advance.state.message) notify.success(advance.state.message);
    if (advance.state.error) notify.error(advance.state.error);
  }, [advance.state]);

  const move = (to: string) => {
    const fd = new FormData();
    fd.set("sellerOrderId", sellerOrderId);
    fd.set("to", to);
    advance.dispatch(fd);
  };

  const terminal = status === "DELIVERED" || status === "CANCELLED";
  const shipmentLocked = terminal || shipment?.status === "DELIVERED";

  return (
    <div className="space-y-5">
      {/* --- status controls --- */}
      {allowedMoves.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {allowedMoves.map((to) => (
            <button
              key={to}
              type="button"
              disabled={advance.pending}
              onClick={() => move(to)}
              className={to === "PROCESSING" ? "btn btn-outline py-2 text-sm" : "btn btn-primary py-2 text-sm"}
            >
              {advance.pending && <Loader2 size={13} className="animate-spin" />}
              {to === "PROCESSING"
                ? "Move back to preparing"
                : to === "READY_TO_SHIP"
                  ? "Mark ready to ship"
                  : to === "SHIPPED"
                    ? "Mark shipped"
                    : "Mark delivered"}
            </button>
          ))}
        </div>
      )}
      {terminal && (
        <p className="text-sm text-ink-faint">
          This order is {sellerOrderStatusLabel(status).toLowerCase()} — no further action needed.
        </p>
      )}
      {status === "READY_TO_SHIP" && !shipment && (
        <p className="text-xs text-warning">Add a shipment before you can mark this shipped.</p>
      )}

      {/* --- shipment --- */}
      <div className="border-t border-line pt-4">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold">
            <Truck size={14} /> Shipment
          </h3>
          {!shipmentLocked && (
            <button
              type="button"
              onClick={() => setShipmentOpen(true)}
              className="text-xs text-ink-soft hover:text-ink"
            >
              {shipment ? "Edit" : "Add"}
            </button>
          )}
        </div>

        {shipment ? (
          <dl className="space-y-1.5 text-sm">
            <Row label="Carrier">{shipment.carrierLabel}</Row>
            <Row label="Tracking #">{shipment.trackingNumber ?? "—"}</Row>
            {shipment.trackingUrl && (
              <Row label="Link">
                <a
                  href={shipment.trackingUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-clay hover:underline"
                >
                  Track <ExternalLink size={11} />
                </a>
              </Row>
            )}
            {shipment.note && <Row label="Note">{shipment.note}</Row>}
            <Row label="Status">{shipment.status}</Row>
          </dl>
        ) : (
          <p className="text-sm text-ink-faint">No shipment yet.</p>
        )}
      </div>

      <ShipmentModal
        open={shipmentOpen}
        onClose={() => setShipmentOpen(false)}
        sellerOrderId={sellerOrderId}
        shipment={shipment}
      />
    </div>
  );
}

function ShipmentModal({
  open,
  onClose,
  sellerOrderId,
  shipment,
}: {
  open: boolean;
  onClose: () => void;
  sellerOrderId: string;
  shipment: ShipmentView;
}) {
  const form = usePersistentAction<SellerOrderActionState>(saveShipmentAction, {});
  const fe = form.state.fieldErrors ?? {};

  useEffect(() => {
    if (form.state.ok) {
      if (form.state.message) notify.success(form.state.message);
      onClose();
    }
    if (form.state.error) notify.error(form.state.error);
  }, [form.state, onClose]);

  return (
    <Modal open={open} onClose={onClose} title={shipment ? "Edit shipment" : "Add shipment"} size="sm">
      <form onSubmit={form.onSubmit} className="space-y-3">
        <input type="hidden" name="sellerOrderId" value={sellerOrderId} />
        {shipment && <input type="hidden" name="shipmentId" value={shipment.id} />}
        <FormField label="Carrier" htmlFor="carrier" required error={fe.carrier}>
          <Select id="carrier" name="carrier" defaultValue={shipment?.carrier ?? ""}>
            <option value="" disabled>
              Choose…
            </option>
            {SHIP_CARRIERS.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Courier name" htmlFor="carrierName" hint="Required only for “Other”" error={fe.carrierName}>
          <input id="carrierName" name="carrierName" maxLength={60} defaultValue={shipment?.carrierName ?? ""} className="field text-sm" />
        </FormField>
        <FormField label="Tracking number" htmlFor="trackingNumber" error={fe.trackingNumber}>
          <input
            id="trackingNumber"
            name="trackingNumber"
            maxLength={40}
            defaultValue={shipment?.trackingNumber ?? ""}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Tracking link" htmlFor="trackingUrl" hint="Optional — auto-built for most carriers" error={fe.trackingUrl}>
          <input
            id="trackingUrl"
            name="trackingUrl"
            type="url"
            maxLength={500}
            defaultValue={shipment?.trackingUrl ?? ""}
            className="field text-sm"
          />
        </FormField>
        <FormField label="Fulfilment note" htmlFor="note" hint="Internal — not shown to the buyer" error={fe.note}>
          <input id="note" name="note" maxLength={300} defaultValue={shipment?.note ?? ""} className="field text-sm" />
        </FormField>
        {form.state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{form.state.error}</p>
        )}
        <div className="flex gap-2 pt-1">
          <button type="submit" disabled={form.pending} className="btn btn-primary py-2 text-sm">
            {form.pending && <Loader2 size={13} className="animate-spin" />}
            {shipment ? "Save" : "Add shipment"}
          </button>
          <button type="button" onClick={onClose} className="btn btn-ghost py-2 text-sm">
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="text-right font-medium text-ink">{children}</dd>
    </div>
  );
}
