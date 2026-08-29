"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, Pencil, Loader2 } from "lucide-react";
import { Card, StatusBadge, FormField, notify, usePersistentAction } from "@/components/admin/ui";
import { Modal } from "@/components/admin/ui";
import {
  createShippingMethodAction,
  updateShippingMethodAction,
  setShippingMethodActiveAction,
  type ShippingActionState,
} from "@/lib/admin/shipping-actions";
import type { AdminShippingMethod } from "@/lib/admin/shipping";
import { formatPrice, formatDate } from "@/lib/utils";

const EMPTY: ShippingActionState = {};

export function ShippingMethods({
  methods,
  canManage,
}: {
  methods: AdminShippingMethod[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<AdminShippingMethod | "new" | null>(null);
  const [pending, startTransition] = useTransition();

  function toggleActive(m: AdminShippingMethod) {
    startTransition(async () => {
      const res = await setShippingMethodActiveAction({ id: m.id, active: !m.active });
      if (res.ok) {
        notify.success(m.active ? "Method deactivated" : "Method activated");
        router.refresh();
      } else {
        notify.error(res.error ?? "Couldn’t update the method");
      }
    });
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <button onClick={() => setEditing("new")} className="btn btn-outline py-2 text-sm">
            <Plus size={14} /> New method
          </button>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
            <tr>
              <th className="py-2 pr-3 font-medium">Method</th>
              <th className="py-2 pr-3 font-medium">Code</th>
              <th className="py-2 pr-3 font-medium">Rate</th>
              <th className="py-2 pr-3 font-medium">Status</th>
              <th className="py-2 pr-3 font-medium">Orders</th>
              <th className="py-2 pr-3 font-medium">Updated</th>
              <th className="py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {methods.map((m) => (
              <tr key={m.id}>
                <td className="py-3 pr-3">
                  <p className="font-medium text-ink">{m.name}</p>
                  {m.description && <p className="text-xs text-ink-faint">{m.description}</p>}
                </td>
                <td className="py-3 pr-3 font-mono text-xs text-ink-soft">{m.code}</td>
                <td className="py-3 pr-3 tabular-nums">
                  {m.rate === 0 ? "Free" : formatPrice(m.rate)}
                </td>
                <td className="py-3 pr-3">
                  <StatusBadge tone={m.active ? "success" : "neutral"}>
                    {m.active ? "Active" : "Inactive"}
                  </StatusBadge>
                </td>
                <td className="py-3 pr-3 tabular-nums text-ink-soft">{m.orderCount}</td>
                <td className="py-3 pr-3 text-xs text-ink-faint">{formatDate(m.updatedAt)}</td>
                <td className="py-3 text-right">
                  {canManage && (
                    <div className="inline-flex items-center gap-3">
                      <button
                        onClick={() => toggleActive(m)}
                        disabled={pending}
                        className="text-xs font-medium text-ink-soft hover:text-ink"
                      >
                        {m.active ? "Deactivate" : "Activate"}
                      </button>
                      <button
                        onClick={() => setEditing(m)}
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

      {methods.length === 0 && (
        <Card className="text-sm text-ink-faint">No shipping methods yet.</Card>
      )}

      {!canManage && (
        <p className="text-xs text-ink-faint">
          Read-only — the <code className="text-ink-soft">manage_shipping</code> permission is
          required to edit.
        </p>
      )}

      {editing !== null && (
        <MethodModal
          method={editing === "new" ? null : editing}
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

function MethodModal({
  method,
  onClose,
  onSaved,
}: {
  method: AdminShippingMethod | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { state, onSubmit, pending } = usePersistentAction<ShippingActionState>(
    method ? updateShippingMethodAction : createShippingMethodAction,
    EMPTY,
  );
  const fe = state.fieldErrors ?? {};
  const savedRef = useRef(false);

  useEffect(() => {
    if (state.ok && !savedRef.current) {
      savedRef.current = true;
      notify.success("Shipping method saved");
      onSaved();
    }
  }, [state.ok, onSaved]);

  return (
    <Modal
      open
      onClose={onClose}
      title={method ? `Edit ${method.name}` : "New shipping method"}
      description={method ? `Code ${method.code}` : "The code is a stable identifier and can’t change later."}
    >
      <form onSubmit={onSubmit} className="space-y-4">
        {method && <input type="hidden" name="id" value={method.id} />}

        {!method && (
          <FormField label="Code" htmlFor="sm-code" error={fe.code} hint="e.g. STANDARD, EXPRESS, PICKUP">
            <input id="sm-code" name="code" className="field uppercase" required placeholder="STANDARD" />
          </FormField>
        )}

        <FormField label="Name" htmlFor="sm-name" error={fe.name}>
          <input id="sm-name" name="name" className="field" required defaultValue={method?.name} />
        </FormField>

        <FormField label="Description" htmlFor="sm-desc" error={fe.description}>
          <input
            id="sm-desc"
            name="description"
            className="field"
            defaultValue={method?.description ?? ""}
            placeholder="e.g. 3–7 business days"
          />
        </FormField>

        <div className="grid grid-cols-2 gap-4">
          <FormField label="Rate (₱)" htmlFor="sm-rate" error={fe.ratePesos}>
            <input
              id="sm-rate"
              name="ratePesos"
              type="number"
              min={0}
              step="1"
              className="field"
              required
              defaultValue={method ? method.rate / 100 : 0}
            />
          </FormField>
          <FormField label="Sort order" htmlFor="sm-sort" error={fe.sortOrder}>
            <input
              id="sm-sort"
              name="sortOrder"
              type="number"
              min={0}
              step="1"
              className="field"
              defaultValue={method?.sortOrder ?? 0}
            />
          </FormField>
        </div>

        <input type="hidden" name="currency" value="PHP" />

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="active"
            defaultChecked={method?.active ?? true}
            className="accent-ink"
          />
          Active (selectable at checkout)
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
            Save method
          </button>
        </div>
      </form>
    </Modal>
  );
}
