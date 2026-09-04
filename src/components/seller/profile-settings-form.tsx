"use client";

import { useEffect } from "react";
import { Loader2 } from "lucide-react";
import { COUNTRIES } from "@/lib/countries";
import { SELLER_SOCIAL_KEYS, type SellerContentStatus, type SellerSocialLinks } from "@/lib/marketplace/types";
import {
  saveSellerProfileAction,
  submitSellerProfileAction,
  type SellerSettingsActionState,
} from "@/lib/seller/settings-actions";
import { FormField, Select, notify, usePersistentAction } from "@/components/seller/ui";

const SOCIAL_LABELS: Record<(typeof SELLER_SOCIAL_KEYS)[number], string> = {
  website: "Website",
  facebook: "Facebook",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  x: "X",
};

export function ProfileSettingsForm({
  bio,
  returnPolicy,
  shippingPolicy,
  shipFromCity,
  shipFromCountry,
  socialLinks,
  contentStatus,
}: {
  bio: string | null;
  returnPolicy: string | null;
  shippingPolicy: string | null;
  shipFromCity: string | null;
  shipFromCountry: string | null;
  socialLinks: SellerSocialLinks;
  contentStatus: SellerContentStatus;
}) {
  const save = usePersistentAction<SellerSettingsActionState>(saveSellerProfileAction, {});
  const submit = usePersistentAction<SellerSettingsActionState>(submitSellerProfileAction, {});

  useEffect(() => {
    if (save.state.ok && save.state.message) notify.success(save.state.message);
    if (save.state.error) notify.error(save.state.error);
  }, [save.state]);
  useEffect(() => {
    if (submit.state.ok && submit.state.message) notify.success(submit.state.message);
    if (submit.state.error) notify.error(submit.state.error);
  }, [submit.state]);

  return (
    <div className="space-y-5">
      <form onSubmit={save.onSubmit} className="space-y-5">
        <FormField label="About your store" htmlFor="bio" hint="Up to ~1,200 characters. Plain text.">
          <textarea
            id="bio"
            name="bio"
            rows={4}
            defaultValue={bio ?? ""}
            maxLength={4000}
            className="field text-sm"
            placeholder="Tell customers who you are and what you sell."
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Return policy summary"
            htmlFor="returnPolicy"
            hint="Informational only — Axiaro's return window and process still apply."
          >
            <textarea id="returnPolicy" name="returnPolicy" rows={3} defaultValue={returnPolicy ?? ""} maxLength={6000} className="field text-sm" />
          </FormField>
          <FormField
            label="Shipping policy summary"
            htmlFor="shippingPolicy"
            hint="Informational only — it does not set shipping rates."
          >
            <textarea id="shippingPolicy" name="shippingPolicy" rows={3} defaultValue={shippingPolicy ?? ""} maxLength={6000} className="field text-sm" />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Ships from — city" htmlFor="shipFromCity">
            <input id="shipFromCity" name="shipFromCity" maxLength={80} defaultValue={shipFromCity ?? ""} className="field text-sm" />
          </FormField>
          <FormField label="Ships from — country" htmlFor="shipFromCountry">
            <Select id="shipFromCountry" name="shipFromCountry" defaultValue={shipFromCountry ?? ""}>
              <option value="">Not set</option>
              {COUNTRIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.name}
                </option>
              ))}
            </Select>
          </FormField>
        </div>

        <fieldset className="space-y-3">
          <legend className="text-sm font-medium text-ink">Social links</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {SELLER_SOCIAL_KEYS.map((k) => (
              <FormField key={k} label={SOCIAL_LABELS[k]} htmlFor={`social.${k}`}>
                <input
                  id={`social.${k}`}
                  name={`social.${k}`}
                  type="url"
                  inputMode="url"
                  placeholder="https://"
                  maxLength={300}
                  defaultValue={socialLinks[k] ?? ""}
                  className="field text-sm"
                />
              </FormField>
            ))}
          </div>
        </fieldset>

        {save.state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{save.state.error}</p>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
          <button type="submit" disabled={save.pending} className="btn btn-primary py-2 text-sm">
            {save.pending && <Loader2 size={14} className="animate-spin" />}
            {contentStatus === "APPROVED" ? "Save changes" : "Save draft"}
          </button>
        </div>
      </form>

      {contentStatus === "DRAFT" && (
        <form onSubmit={submit.onSubmit} className="border-t border-line pt-4">
          <p className="mb-2 text-xs text-ink-faint">
            When your profile is ready, submit it for Axiaro to review.
          </p>
          <button type="submit" disabled={submit.pending} className="btn btn-secondary py-2 text-sm">
            {submit.pending && <Loader2 size={14} className="animate-spin" />}
            Submit for review
          </button>
        </form>
      )}
    </div>
  );
}
