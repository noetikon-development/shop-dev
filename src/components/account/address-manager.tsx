"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Plus, Pencil, Trash2, Truck, CreditCard, MapPin } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { COUNTRIES, countryName, getCountry } from "@/lib/countries";
import { usePersistentAction } from "@/components/admin/ui/use-form";
import {
  createAddressAction,
  updateAddressAction,
  deleteAddressAction,
  setDefaultShippingAction,
  setDefaultBillingAction,
  type AddressFormState,
} from "@/lib/address-actions";
import type { AddressDTO } from "@/lib/addresses";

export function AddressManager({ addresses }: { addresses: AddressDTO[] }) {
  const [editing, setEditing] = useState<AddressDTO | "new" | null>(
    addresses.length === 0 ? "new" : null,
  );
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<AddressFormState>, okMsg: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(okMsg);
      else toast.error(res.error ?? "Something went wrong");
    });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg">Addresses</h2>
          <p className="text-sm text-ink-faint">
            Saved for a faster checkout. Set a default for shipping and billing.
          </p>
        </div>
        {editing === null && (
          <button onClick={() => setEditing("new")} className="btn btn-outline !py-2 text-sm">
            <Plus size={15} /> Add address
          </button>
        )}
      </div>

      {editing !== null && (
        <AddressForm
          key={editing === "new" ? "new" : editing.id}
          address={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}

      {editing === null &&
        (addresses.length === 0 ? (
          <div className="card-surface flex flex-col items-center gap-3 p-10 text-center">
            <MapPin size={20} className="text-ink-faint" />
            <p className="text-sm text-ink-soft">No saved addresses yet.</p>
          </div>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2">
            {addresses.map((a) => (
              <li
                key={a.id}
                className={cn(
                  "card-surface flex flex-col p-4 text-sm",
                  (a.defaultShipping || a.defaultBilling) && "border-ink",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                    {a.label}
                  </span>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {a.defaultShipping && (
                      <Badge>
                        <Truck size={10} /> Shipping
                      </Badge>
                    )}
                    {a.defaultBilling && (
                      <Badge>
                        <CreditCard size={10} /> Billing
                      </Badge>
                    )}
                  </div>
                </div>

                <p className="mt-2 font-medium">
                  {a.firstName} {a.lastName}
                </p>
                {a.company && <p className="text-ink-soft">{a.company}</p>}
                <p className="mt-1 text-ink-soft">
                  {a.line1}
                  {a.line2 ? `, ${a.line2}` : ""}
                  <br />
                  {[a.barangay, a.city, a.province, a.postalCode].filter(Boolean).join(", ")}
                  <br />
                  {countryName(a.country)}
                  <br />
                  {a.phone}
                </p>

                <div className="mt-3 flex flex-wrap gap-x-3 gap-y-2 border-t border-line pt-3 text-xs">
                  <button
                    onClick={() => setEditing(a)}
                    className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                  {!a.defaultShipping && (
                    <button
                      onClick={() =>
                        run(() => setDefaultShippingAction(a.id), "Default shipping address updated")
                      }
                      disabled={pending}
                      className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
                    >
                      <Truck size={12} /> Default shipping
                    </button>
                  )}
                  {!a.defaultBilling && (
                    <button
                      onClick={() =>
                        run(() => setDefaultBillingAction(a.id), "Default billing address updated")
                      }
                      disabled={pending}
                      className="inline-flex items-center gap-1 text-ink-soft hover:text-ink"
                    >
                      <CreditCard size={12} /> Default billing
                    </button>
                  )}
                  <button
                    onClick={() => run(() => deleteAddressAction(a.id), "Address removed")}
                    disabled={pending}
                    className="inline-flex items-center gap-1 text-ink-faint hover:text-sale"
                  >
                    <Trash2 size={12} /> Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-ink px-2 py-0.5 text-[10px] font-medium text-paper">
      {children}
    </span>
  );
}

const EMPTY: AddressFormState = {};

function AddressForm({
  address,
  onCancel,
  onSaved,
}: {
  address: AddressDTO | null;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { state, onSubmit, pending } = usePersistentAction<AddressFormState>(
    address ? updateAddressAction : createAddressAction,
    EMPTY,
  );
  const savedRef = useRef(false);
  const [country, setCountry] = useState(address?.country ?? "PH");

  useEffect(() => {
    if (state.ok && !savedRef.current) {
      savedRef.current = true;
      toast.success("Address saved");
      onSaved();
    }
  }, [state.ok, onSaved]);

  const fe = state.fieldErrors ?? {};
  const c = getCountry(country);

  return (
    <form onSubmit={onSubmit} className="card-surface space-y-4 p-5">
      {address && <input type="hidden" name="id" value={address.id} />}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Label" name="label" error={fe.label} defaultValue={address?.label ?? "Home"} />
        <div className="hidden sm:block" />

        <Field label="First name" name="firstName" required error={fe.firstName} defaultValue={address?.firstName} />
        <Field label="Last name" name="lastName" required error={fe.lastName} defaultValue={address?.lastName} />

        <Field label="Company (optional)" name="company" error={fe.company} defaultValue={address?.company ?? ""} className="sm:col-span-2" />

        <Field label="Phone" name="phone" required error={fe.phone} defaultValue={address?.phone} placeholder="+63 9XX XXX XXXX" />
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Country</span>
          <select
            name="country"
            value={country}
            onChange={(e) => setCountry(e.target.value)}
            className="field"
          >
            {COUNTRIES.map((co) => (
              <option key={co.code} value={co.code}>
                {co.name}
              </option>
            ))}
          </select>
          {fe.country && <span className="mt-1 block text-xs text-clay">{fe.country}</span>}
        </label>

        <Field label="Address line 1" name="line1" required error={fe.line1} defaultValue={address?.line1} className="sm:col-span-2" />
        <Field label="Address line 2 (optional)" name="line2" error={fe.line2} defaultValue={address?.line2 ?? ""} className="sm:col-span-2" />

        {c?.usesBarangay && (
          <Field label="Barangay" name="barangay" error={fe.barangay} defaultValue={address?.barangay ?? ""} />
        )}
        <Field label="City / Municipality" name="city" required error={fe.city} defaultValue={address?.city} />
        <Field
          label={c ? `${c.regionLabel} / State` : "State / Province / Region"}
          name="province"
          required
          error={fe.province}
          defaultValue={address?.province}
        />
        {c?.subregionLabel && (
          <Field label={c.subregionLabel} name="region" error={fe.region} defaultValue={address?.region ?? ""} />
        )}
        <Field label="Postal code" name="postalCode" required error={fe.postalCode} defaultValue={address?.postalCode} />
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-sm bg-surface-sunken/60 p-3">
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="defaultShipping"
            defaultChecked={address?.defaultShipping ?? false}
            className="accent-ink"
          />
          Default shipping address
        </label>
        <label className="inline-flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="defaultBilling"
            defaultChecked={address?.defaultBilling ?? false}
            className="accent-ink"
          />
          Default billing address
        </label>
      </div>

      {state.error && !state.fieldErrors && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}
      {state.error && state.fieldErrors && (
        <p className="text-sm text-clay">{state.error}</p>
      )}

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

function Field({
  label,
  name,
  required,
  error,
  defaultValue,
  placeholder,
  className,
}: {
  label: string;
  name: string;
  required?: boolean;
  error?: string;
  defaultValue?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1.5 block text-sm font-medium">
        {label}
        {required && <span className="text-clay"> *</span>}
      </span>
      <input
        name={name}
        required={required}
        defaultValue={defaultValue}
        placeholder={placeholder}
        className="field"
      />
      {error && <span className="mt-1 block text-xs text-clay">{error}</span>}
    </label>
  );
}
