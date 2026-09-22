"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Loader2 } from "lucide-react";
import { Card, StatusBadge, FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import { Modal } from "@/components/admin/ui";
import {
  createPickupLocationAction,
  updatePickupLocationAction,
  setPickupLocationActiveAction,
  type PickupLocationActionState,
} from "@/lib/admin/pickup-location-actions";
import type { AdminPickupLocation } from "@/lib/admin/pickup-locations";
import { COUNTRIES, countryName } from "@/lib/countries";

const EMPTY: PickupLocationActionState = {};

function addressLine(l: AdminPickupLocation): string {
  return [
    l.line1,
    l.line2,
    [l.barangay, l.city].filter(Boolean).join(", "),
    [l.province, l.postalCode].filter(Boolean).join(" "),
    countryName(l.country),
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * Axiaro-owned Store Pickup location CMS (Phase 9F-49 CMS step). Structurally
 * mirrors `ShippingMethods` (`shipping-methods.tsx`) — same list/modal/toggle
 * pattern, same `manage_shipping` gate. Not connected to checkout; this is a
 * standalone admin surface for the location data itself.
 */
export function PickupLocations({
  locations,
  canManage,
}: {
  locations: AdminPickupLocation[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<AdminPickupLocation | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleActive(l: AdminPickupLocation) {
    startTransition(async () => {
      const res = await setPickupLocationActiveAction({ id: l.id, active: !l.active });
      if (res.ok) {
        notify.success(l.active ? "Location deactivated" : "Location activated");
        router.refresh();
      } else {
        notify.error(res.error ?? "Couldn’t update the location");
      }
    });
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <button onClick={() => setEditing("new")} className="btn btn-outline py-2 text-sm">
            <Plus size={14} /> New location
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="py-2 pr-3 font-medium">Name</th>
              <th className="py-2 pr-3 font-medium">Address</th>
              <th className="py-2 pr-3 font-medium">Phone</th>
              <th className="py-2 pr-3 font-medium">Instructions</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Sort</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {locations.map((l) => (
              <tr key={l.id}>
                <td className="py-3 pr-3">
                  <p className="font-medium text-ink">{l.name}</p>
                  <p className="text-xs text-ink-faint">{l.recipient}</p>
                </td>
                <td className="py-3 pr-3 max-w-[280px] text-xs text-ink-soft">{addressLine(l)}</td>
                <td className="py-3 pr-3 text-xs text-ink-soft">{l.phone}</td>
                <td className="py-3 pr-3 max-w-[220px] text-xs text-ink-faint">{l.instructions ?? "—"}</td>
                <td className="py-3 pr-3">
                  <StatusBadge tone={l.active ? "success" : "neutral"}>
                    {l.active ? "Active" : "Inactive"}
                  </StatusBadge>
                </td>
                <td className="py-3 pr-3 tabular-nums text-ink-soft">{l.sortOrder}</td>
                <td className="py-3 text-right">
                  {canManage && (
                    <div className="inline-flex items-center gap-3">
                      <button
                        onClick={() => toggleActive(l)}
                        disabled={pending}
                        className="text-xs font-medium text-ink-soft hover:text-ink"
                      >
                        {l.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => setEditing(l)}
                        className="inline-flex items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink"
                      >
                        <Pencil size={12} /> Edit
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {locations.length === 0 && (
        <Card className="text-sm text-ink-faint">
          No pickup locations yet. Customers see only the legacy Store Pickup description until one is added here.
        </Card>
      )}

      {!canManage && (
        <p className="text-xs text-ink-faint">
          Read-only — the <code className="text-ink-soft">manage_shipping</code> permission is
          required to edit.
        </p>
      )}

      {editing !== null && (
        <LocationModal
          location={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            router.refresh();
          }}
        />
      )}
    </div>
  );
}

function LocationModal({
  location,
  onClose,
  onSaved,
}: {
  location: AdminPickupLocation | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { state, onSubmit, pending } = usePersistentAction<PickupLocationActionState>(
    location ? updatePickupLocationAction : createPickupLocationAction,
    EMPTY,
  );
  const fe = state.fieldErrors ?? {};
  const savedRef = useRef(false);

  useEffect(() => {
    if (state.ok && !savedRef.current) {
      savedRef.current = true;
      notify.success("Pickup location saved");
      onSaved();
    }
  }, [state.ok, onSaved]);

  return (
    <Modal
      open
      onClose={onClose}
      title={location ? `Edit ${location.name}` : "New pickup location"}
      description="Axiaro-owned location. Not yet shown at checkout — this only manages the CMS record."
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {location && <input type="hidden" name="id" value={location.id} />}

        <FormField label="Name" htmlFor="pl-name" error={fe.name} hint="Internal + admin-facing, e.g. “Batangas City Store”.">
          <input id="pl-name" name="name" className="field" required defaultValue={location?.name} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Recipient / contact name" htmlFor="pl-recipient" error={fe.recipient}>
            <input id="pl-recipient" name="recipient" className="field" required defaultValue={location?.recipient} />
          </FormField>
          <FormField label="Phone" htmlFor="pl-phone" error={fe.phone}>
            <input id="pl-phone" name="phone" className="field" required defaultValue={location?.phone} />
          </FormField>
        </div>

        <FormField label="Address line 1" htmlFor="pl-line1" error={fe.line1}>
          <input id="pl-line1" name="line1" className="field" required defaultValue={location?.line1} />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Address line 2 (optional)" htmlFor="pl-line2" error={fe.line2}>
            <input id="pl-line2" name="line2" className="field" defaultValue={location?.line2 ?? ""} />
          </FormField>
          <FormField label="Barangay (optional)" htmlFor="pl-barangay" error={fe.barangay}>
            <input id="pl-barangay" name="barangay" className="field" defaultValue={location?.barangay ?? ""} />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="City / municipality" htmlFor="pl-city" error={fe.city}>
            <input id="pl-city" name="city" className="field" required defaultValue={location?.city} />
          </FormField>
          <FormField label="Province / region" htmlFor="pl-province" error={fe.province}>
            <input id="pl-province" name="province" className="field" required defaultValue={location?.province} />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Postal code" htmlFor="pl-postal" error={fe.postalCode}>
            <input id="pl-postal" name="postalCode" className="field" required defaultValue={location?.postalCode} />
          </FormField>
          <FormField label="Country" htmlFor="pl-country" error={fe.country}>
            <Select id="pl-country" name="country" required defaultValue={location?.country ?? "PH"}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <FormField
          label="Customer pickup instructions (optional)"
          htmlFor="pl-instructions"
          error={fe.instructions}
          hint="e.g. “Ready in 1–2 days. Bring a valid ID.”"
        >
          <textarea id="pl-instructions" name="instructions" rows={2} className="field text-sm" defaultValue={location?.instructions ?? ""} />
        </FormField>

        <FormField label="Sort order" htmlFor="pl-sort" error={fe.sortOrder}>
          <input
            id="pl-sort"
            name="sortOrder"
            type="number"
            min={0}
            step="1"
            className="field"
            defaultValue={location?.sortOrder ?? 0}
          />
        </FormField>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" defaultChecked={location?.active ?? true} className="accent-ink" />
          Active
        </label>

        {state.error && !state.fieldErrors && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn btn-outline py-2 text-sm">
            Cancel
          </button>
          <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
            {pending && <Loader2 size={14} className="animate-spin" />}
            Save location
          </button>
        </div>
      </form>
    </Modal>
  );
}
