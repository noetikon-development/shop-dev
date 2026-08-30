"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import { Card, FormField, notify, usePersistentAction } from "@/components/admin/ui";
import { MediaPickerField } from "@/components/admin/media/media-picker";
import {
  updateSettingsAction,
  type SettingsActionState,
} from "@/lib/admin/settings-actions";
import type { SettingField } from "@/lib/admin/settings-registry";
import type { PickerAsset } from "@/lib/admin/media-picker-data";

const EMPTY: SettingsActionState = {};

export function SettingsGroupForm({
  groupKey,
  groupLabel,
  groupDescription,
  fields,
  values,
  canManage,
  mediaAssets,
}: {
  groupKey: string;
  groupLabel: string;
  groupDescription: string;
  fields: SettingField[];
  values: Record<string, unknown>;
  canManage: boolean;
  mediaAssets: PickerAsset[];
}) {
  const { state, onSubmit, pending } = usePersistentAction<SettingsActionState>(updateSettingsAction, EMPTY);
  const doneRef = useRef(false);
  const fe = state.fieldErrors ?? {};

  useEffect(() => {
    if (state.ok && state.savedGroup === groupKey && !doneRef.current) {
      doneRef.current = true;
      notify.success(`${groupLabel} saved`);
    }
    if (state.error || state.fieldErrors) doneRef.current = false;
  }, [state, groupKey, groupLabel]);

  const editable = fields.filter((f) => f.type !== "json");
  const readOnly = fields.filter((f) => f.type === "json");

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-4">
        <input type="hidden" name="__group" value={groupKey} />
        <div>
          <h2 className="text-sm font-semibold text-ink">{groupLabel}</h2>
          <p className="text-xs text-ink-faint">{groupDescription}</p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {editable.map((field) => {
            const val = values[field.key];
            const strVal = val == null ? "" : String(val);
            if (field.type === "media") {
              return (
                <MediaPickerField
                  key={field.key}
                  name={field.key}
                  label={field.label}
                  assets={mediaAssets}
                  defaultValue={strVal}
                  error={fe[field.key]}
                  hint={field.help}
                />
              );
            }
            if (field.type === "boolean") {
              return (
                <label key={field.key} className="col-span-full flex items-start gap-2 text-sm">
                  <input
                    type="checkbox"
                    name={field.key}
                    defaultChecked={val === true}
                    disabled={!canManage}
                    className="mt-0.5 accent-ink"
                  />
                  <span>
                    {field.label}
                    {field.help && <span className="block text-xs text-ink-faint">{field.help}</span>}
                  </span>
                </label>
              );
            }
            const isWide = field.type === "text";
            return (
              <div key={field.key} className={isWide ? "col-span-full" : ""}>
                <FormField label={field.label} htmlFor={`s-${field.key}`} error={fe[field.key]} hint={field.help}>
                  {field.type === "text" ? (
                    <textarea
                      id={`s-${field.key}`}
                      name={field.key}
                      rows={3}
                      defaultValue={strVal}
                      disabled={!canManage}
                      className="field text-sm"
                    />
                  ) : (
                    <input
                      id={`s-${field.key}`}
                      name={field.key}
                      type={field.type === "email" ? "email" : field.type === "number" ? "number" : "text"}
                      inputMode={field.type === "number" ? "numeric" : undefined}
                      placeholder={field.type === "url" ? "https://…" : undefined}
                      defaultValue={strVal}
                      disabled={!canManage}
                      className="field text-sm"
                    />
                  )}
                </FormField>
              </div>
            );
          })}
        </div>

        {readOnly.length > 0 && (
          <dl className="rounded-md border border-line bg-surface-sunken/40 p-3 text-xs">
            {readOnly.map((f) => (
              <div key={f.key} className="flex justify-between gap-4 py-1">
                <dt className="text-ink-faint">{f.label}</dt>
                <dd className="text-ink-soft">{JSON.stringify(values[f.key])}</dd>
              </div>
            ))}
            <p className="mt-1 text-ink-faint">
              Configured elsewhere (Shipping methods / server environment).
            </p>
          </dl>
        )}

        {state.error && !state.fieldErrors && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        {canManage && (
          <div className="flex justify-end">
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              Save {groupLabel.toLowerCase()}
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}
