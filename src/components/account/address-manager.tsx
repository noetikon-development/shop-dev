"use client";

import { useState, useTransition } from "react";
import { Plus, Pencil, Trash2, Check, Star } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { saveAddress, deleteAddress, setDefaultAddress } from "@/lib/actions";

type Address = {
  id: string;
  label: string;
  recipient: string;
  phone: string;
  line1: string;
  line2: string | null;
  barangay: string | null;
  city: string;
  province: string;
  region: string | null;
  postalCode: string;
  isDefault: boolean;
};

export function AddressManager({ addresses }: { addresses: Address[] }) {
  const [editing, setEditing] = useState<Address | "new" | null>(
    addresses.length === 0 ? "new" : null,
  );
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg">Addresses</h2>
        {editing === null && (
          <button onClick={() => setEditing("new")} className="btn btn-outline !py-2 text-sm">
            <Plus size={15} /> Add address
          </button>
        )}
      </div>

      {editing !== null && (
        <AddressForm
          address={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {editing === null && (
        <ul className="grid gap-4 sm:grid-cols-2">
          {addresses.map((a) => (
            <li
              key={a.id}
              className={cn(
                "card-surface relative p-4 text-sm",
                a.isDefault && "border-ink",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  {a.label}
                </span>
                {a.isDefault && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium text-ink">
                    <Star size={11} fill="currentColor" /> Default
                  </span>
                )}
              </div>
              <p className="mt-2 font-medium">{a.recipient}</p>
              <p className="mt-1 text-ink-soft">
                {a.line1}
                {a.line2 ? `, ${a.line2}` : ""}
                <br />
                {[a.barangay, a.city, a.province, a.postalCode].filter(Boolean).join(", ")}
                <br />
                {a.phone}
              </p>
              <div className="mt-3 flex flex-wrap gap-3 border-t border-line pt-3 text-xs">
                <button
                  onClick={() => setEditing(a)}
                  className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
                >
                  <Pencil size={12} /> Edit
                </button>
                {!a.isDefault && (
                  <button
                    onClick={() =>
                      startTransition(async () => {
                        await setDefaultAddress(a.id);
                        toast.success("Default address updated");
                      })
                    }
                    disabled={pending}
                    className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
                  >
                    <Check size={12} /> Set default
                  </button>
                )}
                <button
                  onClick={() =>
                    startTransition(async () => {
                      await deleteAddress(a.id);
                      toast.success("Address removed");
                    })
                  }
                  disabled={pending}
                  className="inline-flex items-center gap-1 text-ink-faint hover:text-sale"
                >
                  <Trash2 size={12} /> Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddressForm({
  address,
  onCancel,
  onSaved,
}: {
  address: Address | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      action={(fd) =>
        startTransition(async () => {
          const res = await saveAddress(null, fd);
          if (res?.ok) {
            toast.success("Address saved");
            onSaved();
          } else {
            setError(res?.error ?? "Something went wrong");
          }
        })
      }
      className="card-surface space-y-4 p-5"
    >
      {address && <input type="hidden" name="id" value={address.id} />}
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Label</span>
          <input name="label" defaultValue={address?.label ?? "Home"} className="field" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Recipient name</span>
          <input name="recipient" required defaultValue={address?.recipient} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Phone</span>
          <input name="phone" required defaultValue={address?.phone} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Postal code</span>
          <input name="postalCode" required defaultValue={address?.postalCode} className="field" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Address line 1</span>
          <input name="line1" required defaultValue={address?.line1} className="field" />
        </label>
        <label className="block sm:col-span-2">
          <span className="mb-1.5 block text-sm font-medium">Address line 2</span>
          <input name="line2" defaultValue={address?.line2 ?? ""} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Barangay</span>
          <input name="barangay" defaultValue={address?.barangay ?? ""} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">City / Municipality</span>
          <input name="city" required defaultValue={address?.city} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Province</span>
          <input name="province" required defaultValue={address?.province} className="field" />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Region</span>
          <input name="region" defaultValue={address?.region ?? ""} className="field" />
        </label>
      </div>

      {error && <p className="text-sm text-clay">{error}</p>}

      <div className="flex gap-3">
        <button type="submit" disabled={pending} className="btn btn-primary">
          {pending ? "Saving…" : "Save address"}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-ghost">
          Cancel
        </button>
      </div>
    </form>
  );
}
