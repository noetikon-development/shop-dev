"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { Card, FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";
import {
  createCouponAction,
  updateCouponAction,
  type CouponActionState,
} from "@/lib/admin/coupon-actions";

const EMPTY: CouponActionState = {};

type CouponDefaults = {
  id: string;
  code: string;
  description: string | null;
  type: string;
  value: number;
  maxDiscount: number | null;
  minSubtotal: number;
  startsAt: string | null;
  expiresAt: string | null;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  active: boolean;
};

/** ISO → the `YYYY-MM-DDTHH:mm` a datetime-local input wants (local time). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function CouponForm({ coupon }: { coupon?: CouponDefaults }) {
  const router = useRouter();
  const editing = Boolean(coupon);
  const { state, onSubmit, pending } = usePersistentAction<CouponActionState>(
    editing ? updateCouponAction : createCouponAction,
    EMPTY,
  );
  const [type, setType] = useState(coupon?.type === "FIXED" ? "FIXED" : "PERCENT");
  const fe = state.fieldErrors ?? {};
  const doneRef = useRef(false);

  useEffect(() => {
    if (!state.ok || doneRef.current) return;
    doneRef.current = true;
    if (state.createdId) {
      notify.success("Coupon created");
      router.push(`/admin/marketing/coupons/${state.createdId}`);
    } else {
      notify.success("Coupon saved");
      router.refresh();
    }
  }, [state.ok, state.createdId, router]);

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {editing && <input type="hidden" name="id" value={coupon!.id} />}

      <Card>
        <h2 className="text-sm font-semibold text-ink">Basic information</h2>
        <div className="mt-3 space-y-4">
          {editing ? (
            <FormField label="Coupon code" htmlFor="c-code" hint="The code can’t be changed after creation.">
              <input
                id="c-code"
                className="field font-mono uppercase"
                defaultValue={coupon!.code}
                disabled
              />
            </FormField>
          ) : (
            <FormField label="Coupon code" htmlFor="c-code" error={fe.code} hint="3–24 letters or digits, e.g. WELCOME10">
              <input
                id="c-code"
                name="code"
                className="field font-mono uppercase"
                required
                autoComplete="off"
                placeholder="WELCOME10"
              />
            </FormField>
          )}
          <FormField label="Description" htmlFor="c-desc" error={fe.description} hint="Shown to customers on the promotions page.">
            <input
              id="c-desc"
              name="description"
              className="field"
              defaultValue={coupon?.description ?? ""}
              placeholder="10% off your first order"
            />
          </FormField>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Discount</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FormField label="Type" htmlFor="c-type">
            <Select
              id="c-type"
              name="type"
              value={type}
              onChange={(e) => setType(e.target.value)}
            >
              <option value="PERCENT">Percentage</option>
              <option value="FIXED">Fixed amount</option>
            </Select>
          </FormField>
          <FormField
            label={type === "PERCENT" ? "Percentage (%)" : "Amount (₱)"}
            htmlFor="c-value"
            error={fe.value}
          >
            <input
              id="c-value"
              name="value"
              type="number"
              min={1}
              max={type === "PERCENT" ? 100 : undefined}
              step={type === "PERCENT" ? 1 : 1}
              className="field"
              required
              defaultValue={
                coupon ? (coupon.type === "PERCENT" ? coupon.value : coupon.value / 100) : ""
              }
            />
          </FormField>
          {type === "PERCENT" && (
            <FormField
              label="Maximum discount (₱)"
              htmlFor="c-max"
              error={fe.maxDiscount}
              hint="Optional — caps a percentage discount."
            >
              <input
                id="c-max"
                name="maxDiscount"
                type="number"
                min={0}
                step={1}
                className="field"
                defaultValue={coupon?.maxDiscount != null ? coupon.maxDiscount / 100 : ""}
              />
            </FormField>
          )}
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Requirements</h2>
        <FormField
          label="Minimum order amount (₱)"
          htmlFor="c-min"
          error={fe.minSubtotal}
          hint="Optional — the merchandise subtotal must reach this before the coupon applies."
        >
          <input
            id="c-min"
            name="minSubtotal"
            type="number"
            min={0}
            step={1}
            className="field mt-3 max-w-xs"
            defaultValue={coupon?.minSubtotal ? coupon.minSubtotal / 100 : ""}
          />
        </FormField>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Validity</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FormField label="Starts at" htmlFor="c-start" error={fe.startsAt} hint="Optional. Server time.">
            <input
              id="c-start"
              name="startsAt"
              type="datetime-local"
              className="field"
              defaultValue={toLocalInput(coupon?.startsAt ?? null)}
            />
          </FormField>
          <FormField label="Expires at" htmlFor="c-end" error={fe.expiresAt} hint="Optional. Server time.">
            <input
              id="c-end"
              name="expiresAt"
              type="datetime-local"
              className="field"
              defaultValue={toLocalInput(coupon?.expiresAt ?? null)}
            />
          </FormField>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Usage</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <FormField label="Total usage limit" htmlFor="c-usage" error={fe.usageLimit} hint="Optional. Blank = unlimited.">
            <input
              id="c-usage"
              name="usageLimit"
              type="number"
              min={1}
              step={1}
              className="field"
              defaultValue={coupon?.usageLimit ?? ""}
            />
          </FormField>
          <FormField label="Per-customer limit" htmlFor="c-per" error={fe.perCustomerLimit} hint="Optional. Blank = unlimited.">
            <input
              id="c-per"
              name="perCustomerLimit"
              type="number"
              min={1}
              step={1}
              className="field"
              defaultValue={coupon?.perCustomerLimit ?? ""}
            />
          </FormField>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-ink">Status</h2>
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="active"
            defaultChecked={coupon?.active ?? false}
            className="accent-ink"
          />
          Active — customers can apply this code now (subject to the dates above)
        </label>
      </Card>

      {state.error && !state.fieldErrors && (
        <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => router.push(editing ? `/admin/marketing/coupons/${coupon!.id}` : "/admin/marketing/coupons")}
          className="btn btn-outline py-2 text-sm"
        >
          Cancel
        </button>
        <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
          {pending && <Loader2 size={14} className="animate-spin" />}
          {editing ? "Save changes" : "Create coupon"}
        </button>
      </div>
    </form>
  );
}
