"use client";

import { useEffect, useState } from "react";
import {
  saveEmailTemplateAction,
  resetEmailTemplateAction,
  previewEmailTemplateAction,
  type EmailTemplateActionState,
  type EmailTemplatePreview,
} from "@/lib/admin/email-template-actions";
import type { EmailTemplateEditState } from "@/lib/admin/email-templates";
import { FormField, Card, notify, usePersistentAction, ConfirmDialog, Modal } from "@/components/admin/ui";

/**
 * CMS email-template editor (Phase 9F-57). One template per screen —
 * everything an admin can customize (subject / heading / body / optional
 * additional message / action label / enabled) plus the token reference and a
 * side-effect-free preview. Reuses the same form/action/notify conventions as
 * every other content editor (`footer-editor.tsx`, `seller-lifecycle-panel.tsx`).
 */
export function EmailTemplateEditor({
  state,
  canManage,
}: {
  state: EmailTemplateEditState;
  canManage: boolean;
}) {
  const { state: formState, onSubmit, pending } = usePersistentAction<EmailTemplateActionState>(
    saveEmailTemplateAction,
    {},
  );
  const [subject, setSubject] = useState(state.data.subject);
  const [heading, setHeading] = useState(state.data.heading);
  const [body, setBody] = useState(state.data.body);
  const [extraMessage, setExtraMessage] = useState(state.data.extraMessage);
  const [actionLabel, setActionLabel] = useState(state.data.actionLabel);
  const [published, setPublished] = useState(state.published);
  const [hasOverride, setHasOverride] = useState(state.hasOverride);

  const [confirmReset, setConfirmReset] = useState(false);
  const [resetPending, setResetPending] = useState(false);
  const [preview, setPreview] = useState<EmailTemplatePreview | null>(null);
  const [previewPending, setPreviewPending] = useState(false);

  useEffect(() => {
    if (formState.ok) {
      notify.success("Template saved.");
      setHasOverride(true);
    }
    if (formState.error) notify.error(formState.error);
  }, [formState]);

  async function handlePreview() {
    setPreviewPending(true);
    const fd = new FormData();
    fd.set("templateKey", state.def.key);
    fd.set("subject", subject);
    fd.set("heading", heading);
    fd.set("body", body);
    fd.set("extraMessage", extraMessage);
    fd.set("actionLabel", actionLabel);
    const res = await previewEmailTemplateAction(fd);
    setPreviewPending(false);
    if (res.ok) setPreview(res.preview);
    else notify.error(res.error);
  }

  async function handleReset() {
    setConfirmReset(false);
    setResetPending(true);
    const res = await resetEmailTemplateAction({ templateKey: state.def.key });
    setResetPending(false);
    if (res.ok) {
      notify.success("Reset to the application default.");
      setSubject("");
      setHeading("");
      setBody("");
      setExtraMessage("");
      setActionLabel("");
      setPublished(false);
      setHasOverride(false);
    } else {
      notify.error(res.error ?? "Could not reset.");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <form onSubmit={onSubmit} className="space-y-5">
        <input type="hidden" name="templateKey" value={state.def.key} />
        <Card className="space-y-4">
          <FormField label="Subject" htmlFor="et-subject" hint="Blank uses the application's default subject.">
            <input
              id="et-subject"
              name="subject"
              disabled={!canManage}
              className="field text-sm"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              maxLength={200}
            />
          </FormField>
          <FormField label="Heading" htmlFor="et-heading" hint="Blank uses the application's default heading.">
            <input
              id="et-heading"
              name="heading"
              disabled={!canManage}
              className="field text-sm"
              value={heading}
              onChange={(e) => setHeading(e.target.value)}
              maxLength={200}
            />
          </FormField>
          <FormField label="Body" htmlFor="et-body" hint="Blank uses the application's default body.">
            <textarea
              id="et-body"
              name="body"
              rows={4}
              disabled={!canManage}
              className="field w-full text-sm"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              maxLength={2000}
            />
          </FormField>
          {state.def.hasExtraMessage && (
            <FormField
              label="Optional additional message"
              htmlFor="et-extra"
              hint="Shown after the body. Leave blank for none."
            >
              <textarea
                id="et-extra"
                name="extraMessage"
                rows={3}
                disabled={!canManage}
                className="field w-full text-sm"
                value={extraMessage}
                onChange={(e) => setExtraMessage(e.target.value)}
                maxLength={2000}
              />
            </FormField>
          )}
          {state.def.hasActionButton && (
            <FormField
              label="Action button label"
              htmlFor="et-cta"
              hint="Blank uses the application's default label."
            >
              <input
                id="et-cta"
                name="actionLabel"
                disabled={!canManage}
                className="field text-sm"
                value={actionLabel}
                onChange={(e) => setActionLabel(e.target.value)}
                maxLength={200}
              />
            </FormField>
          )}
          <label className="flex items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              name="published"
              checked={published}
              disabled={!canManage}
              onChange={(e) => setPublished(e.target.checked)}
            />
            Enabled — use this customization for real sends. When off, this
            template falls back to the application default (same as having no
            customization at all).
          </label>
          {state.def.requiresReason && (
            <p className="rounded-md border border-line bg-paper px-3 py-2 text-xs text-ink-soft">
              This email always includes the admin&apos;s actual{" "}
              <code>{"{{reason}}"}</code> in its own labeled box, regardless of
              what you write above — your body / message text can explain
              anything around it, but it can never replace, invent or hide the
              real reason.
            </p>
          )}
        </Card>

        {canManage && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={handlePreview}
              disabled={previewPending}
              className="btn btn-outline py-2 text-sm"
            >
              {previewPending ? "Rendering…" : "Preview"}
            </button>
            {hasOverride && (
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="btn btn-ghost text-clay py-2 text-sm"
              >
                Reset to default
              </button>
            )}
          </div>
        )}
      </form>

      <div className="space-y-4">
        <Card>
          <h3 className="mb-2 text-sm font-semibold text-ink">Available tokens</h3>
          <ul className="space-y-1">
            {state.def.allowedTokens.map((tok) => (
              <li key={tok}>
                <code className="rounded bg-paper px-1.5 py-0.5 text-xs text-ink-soft">{`{{${tok}}}`}</code>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-ink-faint">
            Any other token — or a typo — is left as literal text in the
            email. It never breaks the send.
          </p>
        </Card>
        {state.updatedAt && (
          <p className="text-xs text-ink-faint">
            Last updated {new Date(state.updatedAt).toLocaleString()}
          </p>
        )}
      </div>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={handleReset}
        title="Reset this template?"
        message="This removes the customization entirely — the email will use the application's built-in default again."
        confirmLabel="Reset"
        pending={resetPending}
      />

      {preview && (
        <Modal open={!!preview} onClose={() => setPreview(null)} size="lg" title={`Preview — ${preview.subject}`}>
          <p className="mb-2 text-xs text-ink-faint">
            Rendered with sample data only — no email was sent.
          </p>
          <iframe
            title="Email preview"
            srcDoc={preview.html}
            className="h-[70vh] w-full rounded border border-line bg-white"
            sandbox=""
          />
        </Modal>
      )}
    </div>
  );
}
