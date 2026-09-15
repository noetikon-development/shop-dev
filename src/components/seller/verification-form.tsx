"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { saveSellerVerificationDraftAction, type SellerVerificationActionState } from "@/lib/seller-verification/actions";
import {
  SELLER_VERIFICATION_BUSINESS_TYPES,
  SELLER_VERIFICATION_BUSINESS_TYPE_LABELS,
  BUSINESS_TYPES_WITH_REGISTRATION,
} from "@/lib/seller-verification/business-types";
import { COUNTRIES, DEFAULT_COUNTRY } from "@/lib/countries";
import { FormField, Select, notify, usePersistentAction } from "@/components/seller/ui";
import type { SellerVerificationView } from "@/lib/seller-verification/repository";

type Props = {
  verification: SellerVerificationView | null;
  /**
   * True once the verification is no longer DRAFT (Phase 5). The whole form
   * is wrapped in a native `<fieldset disabled>` — every input/select/button
   * inside becomes non-interactive in one place, matching the repository's
   * own guard (`saveSellerVerificationDraft` would otherwise happily start a
   * brand-new DRAFT row once the current one is PENDING/APPROVED/REJECTED,
   * which this prop exists specifically to prevent from the UI side).
   */
  readOnly?: boolean;
};

/**
 * Draft-only form — every field is optional at the schema level (see
 * validation.ts), so partial input always saves successfully. Business
 * fields are shown/hidden client-side based on the selected business type;
 * hiding a field never clears its value, so switching back and forth doesn't
 * lose anything already typed (the hidden inputs stay mounted, just visually
 * collapsed, so their values are still part of the submitted FormData).
 */
export function SellerVerificationForm({ verification, readOnly = false }: Props) {
  const { state, onSubmit, pending } = usePersistentAction<SellerVerificationActionState>(
    saveSellerVerificationDraftAction,
    {},
  );
  const [businessType, setBusinessType] = useState(verification?.businessType ?? "");
  const showBusinessFields = businessType !== "" && businessType !== "INDIVIDUAL";
  const showRegistrationFields =
    showBusinessFields && BUSINESS_TYPES_WITH_REGISTRATION.includes(businessType as never);

  useEffect(() => {
    if (state.ok && state.message) notify.success(state.message);
    if (state.error) notify.error(state.error);
  }, [state]);

  const err = (field: string) => state.fieldErrors?.[field];

  return (
    <form onSubmit={onSubmit} className="space-y-8">
      <fieldset disabled={readOnly} className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-semibold">Your details</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Legal / full name" htmlFor="legalName" error={err("legalName")} required>
            <input
              id="legalName"
              name="legalName"
              defaultValue={verification?.legalName ?? ""}
              className="field text-sm"
              autoComplete="name"
            />
          </FormField>
          <FormField label="Mobile / contact number" htmlFor="phone" error={err("phone")} required hint="Not verified yet.">
            <input
              id="phone"
              name="phone"
              type="tel"
              defaultValue={verification?.phone ?? ""}
              className="field text-sm"
              autoComplete="tel"
            />
          </FormField>
        </div>
      </section>

      <section className="space-y-4 border-t border-line pt-6">
        <h2 className="text-sm font-semibold">Address</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Address line 1" htmlFor="addressLine1" error={err("addressLine1")} required>
            <input id="addressLine1" name="addressLine1" defaultValue={verification?.addressLine1 ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="Address line 2" htmlFor="addressLine2" error={err("addressLine2")} hint="Optional.">
            <input id="addressLine2" name="addressLine2" defaultValue={verification?.addressLine2 ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="Barangay" htmlFor="barangay" error={err("barangay")} hint="Optional.">
            <input id="barangay" name="barangay" defaultValue={verification?.barangay ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="City / municipality" htmlFor="city" error={err("city")} required>
            <input id="city" name="city" defaultValue={verification?.city ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="Province" htmlFor="province" error={err("province")} required>
            <input id="province" name="province" defaultValue={verification?.province ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="Postal code" htmlFor="postalCode" error={err("postalCode")} required>
            <input id="postalCode" name="postalCode" defaultValue={verification?.postalCode ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="Country" htmlFor="country" error={err("country")} required>
            <Select id="country" name="country" defaultValue={verification?.country ?? DEFAULT_COUNTRY}>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>
      </section>

      <section className="space-y-4 border-t border-line pt-6">
        <h2 className="text-sm font-semibold">Business information</h2>
        <FormField label="Business type" htmlFor="businessType" error={err("businessType")}>
          <Select
            id="businessType"
            name="businessType"
            value={businessType}
            onChange={(e) => setBusinessType(e.target.value)}
          >
            <option value="">Select a business type</option>
            {SELLER_VERIFICATION_BUSINESS_TYPES.map((t) => (
              <option key={t} value={t}>
                {SELLER_VERIFICATION_BUSINESS_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </FormField>

        <div className={showBusinessFields ? "grid gap-4 sm:grid-cols-2" : "hidden"} aria-hidden={!showBusinessFields}>
          <FormField label="Business / trade name" htmlFor="businessName" error={err("businessName")} required={showBusinessFields}>
            <input id="businessName" name="businessName" defaultValue={verification?.businessName ?? ""} className="field text-sm" />
          </FormField>
        </div>

        <div
          className={showRegistrationFields ? "grid gap-4 sm:grid-cols-2" : "hidden"}
          aria-hidden={!showRegistrationFields}
        >
          <FormField
            label="Business registration number"
            htmlFor="businessRegistrationNumber"
            error={err("businessRegistrationNumber")}
            hint="Optional — the business registration DOCUMENT below is what's required, not this number."
          >
            <input
              id="businessRegistrationNumber"
              name="businessRegistrationNumber"
              defaultValue={verification?.businessRegistrationNumber ?? ""}
              className="field text-sm"
            />
          </FormField>
          <FormField label="DTI registration number" htmlFor="dtiRegistrationNumber" error={err("dtiRegistrationNumber")} hint="Optional.">
            <input
              id="dtiRegistrationNumber"
              name="dtiRegistrationNumber"
              defaultValue={verification?.dtiRegistrationNumber ?? ""}
              className="field text-sm"
            />
          </FormField>
          <FormField label="SEC registration number" htmlFor="secRegistrationNumber" error={err("secRegistrationNumber")} hint="Optional.">
            <input
              id="secRegistrationNumber"
              name="secRegistrationNumber"
              defaultValue={verification?.secRegistrationNumber ?? ""}
              className="field text-sm"
            />
          </FormField>
          <FormField label="TIN" htmlFor="tin" error={err("tin")} hint="Optional.">
            <input id="tin" name="tin" defaultValue={verification?.tin ?? ""} className="field text-sm" />
          </FormField>
        </div>
      </section>

      {state.error && !state.fieldErrors && <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>}

      <div className="border-t border-line pt-6">
        <button type="submit" disabled={pending || readOnly} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          Save draft
        </button>
        {readOnly && (
          <p className="mt-2 text-xs text-ink-faint">
            This information has been submitted and can no longer be edited here.
          </p>
        )}
      </div>
      </fieldset>
    </form>
  );
}
