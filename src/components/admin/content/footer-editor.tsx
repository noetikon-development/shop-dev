"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, Trash2, RotateCcw } from "lucide-react";
import { Card, FormField, notify, usePersistentAction } from "@/components/admin/ui";
import { saveFooterAction } from "@/lib/admin/content-footer-actions";
import { type FooterActionState } from "@/lib/footer-defaults";
import type { FooterData } from "@/lib/content-blocks";

const EMPTY: FooterActionState = {};

type FooterLink = { label: string; href: string; enabled: boolean };
type Column = { heading: string; links: FooterLink[] };

const BLANK_LINK: FooterLink = { label: "", href: "", enabled: true };

export function FooterEditor({
  initial,
  fallback,
  canManage,
}: {
  initial: FooterData | null;
  /** The built-in footer content, offered as a "reset to defaults" starting point. */
  fallback: FooterData;
  canManage: boolean;
}) {
  const { state, onSubmit, pending } = usePersistentAction<FooterActionState>(saveFooterAction, EMPTY);
  const doneRef = useRef(false);

  const [data, setData] = useState<FooterData>(initial ?? fallback);

  useEffect(() => {
    if (state.ok && !doneRef.current) {
      doneRef.current = true;
      notify.success("Footer saved");
    }
    if (state.error) doneRef.current = false;
  }, [state]);

  const set = <K extends keyof FooterData>(key: K, value: FooterData[K]) =>
    setData((d) => ({ ...d, [key]: value }));

  const setColumn = (key: "shopColumn" | "helpColumn" | "companyColumn", col: Column) =>
    setData((d) => ({ ...d, [key]: col }));

  return (
    <Card>
      <form
        onSubmit={(e) => {
          // Serialise current state into the hidden field just before submit.
          const form = e.currentTarget;
          (form.elements.namedItem("data") as HTMLInputElement).value = JSON.stringify(data);
          onSubmit(e);
        }}
        className="space-y-8"
      >
        <input type="hidden" name="data" defaultValue="{}" />

        <Section
          title="Brand"
          hint="Shown under the logo. Leave blank to use the store description from Settings."
        >
          <FormField label="Brand description" htmlFor="f-brand">
            <textarea
              id="f-brand"
              rows={3}
              disabled={!canManage}
              className="field text-sm"
              value={data.brandDescription}
              onChange={(e) => set("brandDescription", e.target.value)}
            />
          </FormField>
        </Section>

        <Section
          title="Newsletter / first-order prompt"
          hint="There is no marketing list — submitting reveals the success message below. Leave all fields blank to hide this section."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Heading" htmlFor="f-nl-heading">
              <input
                id="f-nl-heading"
                disabled={!canManage}
                className="field text-sm"
                value={data.newsletter.heading}
                onChange={(e) => set("newsletter", { ...data.newsletter, heading: e.target.value })}
              />
            </FormField>
            <FormField label="Button label" htmlFor="f-nl-cta" hint="Blank shows an arrow icon.">
              <input
                id="f-nl-cta"
                disabled={!canManage}
                className="field text-sm"
                value={data.newsletter.ctaLabel}
                onChange={(e) => set("newsletter", { ...data.newsletter, ctaLabel: e.target.value })}
              />
            </FormField>
            <div className="sm:col-span-2">
              <FormField label="Sub-text" htmlFor="f-nl-body" hint="Optional line under the heading.">
                <input
                  id="f-nl-body"
                  disabled={!canManage}
                  className="field text-sm"
                  value={data.newsletter.body}
                  onChange={(e) => set("newsletter", { ...data.newsletter, body: e.target.value })}
                />
              </FormField>
            </div>
            <div className="sm:col-span-2">
              <FormField
                label="Success message"
                htmlFor="f-nl-success"
                hint="Shown after submit — keep it accurate about what actually happens."
              >
                <textarea
                  id="f-nl-success"
                  rows={2}
                  disabled={!canManage}
                  className="field text-sm"
                  value={data.newsletter.successText}
                  onChange={(e) =>
                    set("newsletter", { ...data.newsletter, successText: e.target.value })
                  }
                />
              </FormField>
            </div>
          </div>
        </Section>

        <ColumnEditor
          title="Shop column"
          hint="Leave the links empty to show the top categories automatically."
          column={data.shopColumn}
          onChange={(c) => setColumn("shopColumn", c)}
          canManage={canManage}
        />
        <ColumnEditor
          title="Help column"
          column={data.helpColumn}
          onChange={(c) => setColumn("helpColumn", c)}
          canManage={canManage}
        />
        <ColumnEditor
          title="Company column"
          hint="Only add links to pages that exist and are published."
          column={data.companyColumn}
          onChange={(c) => setColumn("companyColumn", c)}
          canManage={canManage}
        />

        <Section title="Legal links" hint="The small links in the bottom bar.">
          <LinkList
            links={data.legalLinks}
            onChange={(links) => set("legalLinks", links)}
            canManage={canManage}
          />
        </Section>

        <Section
          title="Copyright"
          hint="Use {year} for the current year and {brand} for the store name (or legal entity name if set)."
        >
          <FormField label="Copyright line" htmlFor="f-copy">
            <input
              id="f-copy"
              disabled={!canManage}
              className="field text-sm"
              value={data.copyright}
              onChange={(e) => set("copyright", e.target.value)}
            />
          </FormField>
        </Section>

        {state.error && (
          <p className="rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{state.error}</p>
        )}

        {canManage && (
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setData(fallback)}
              className="inline-flex items-center gap-1.5 text-xs text-ink-soft hover:text-ink"
            >
              <RotateCcw size={13} /> Reset to built-in defaults
            </button>
            <button type="submit" disabled={pending} className="btn btn-primary py-2 text-sm">
              {pending && <Loader2 size={14} className="animate-spin" />}
              Save footer
            </button>
          </div>
        )}
      </form>
    </Card>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {hint && <p className="text-xs text-ink-faint">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

function ColumnEditor({
  title,
  hint,
  column,
  onChange,
  canManage,
}: {
  title: string;
  hint?: string;
  column: Column;
  onChange: (c: Column) => void;
  canManage: boolean;
}) {
  return (
    <Section title={title} hint={hint}>
      <FormField label="Heading" htmlFor={`col-${title}`}>
        <input
          id={`col-${title}`}
          disabled={!canManage}
          className="field text-sm"
          value={column.heading}
          onChange={(e) => onChange({ ...column, heading: e.target.value })}
        />
      </FormField>
      <LinkList
        links={column.links}
        onChange={(links) => onChange({ ...column, links })}
        canManage={canManage}
      />
    </Section>
  );
}

function LinkList({
  links,
  onChange,
  canManage,
}: {
  links: FooterLink[];
  onChange: (links: FooterLink[]) => void;
  canManage: boolean;
}) {
  const update = (i: number, patch: Partial<FooterLink>) =>
    onChange(links.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const remove = (i: number) => onChange(links.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {links.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            aria-label="Link label"
            placeholder="Label"
            disabled={!canManage}
            className="field text-sm"
            value={l.label}
            onChange={(e) => update(i, { label: e.target.value })}
          />
          <input
            aria-label="Link destination"
            placeholder="/pages/about or https://…"
            disabled={!canManage}
            className="field text-sm"
            value={l.href}
            onChange={(e) => update(i, { href: e.target.value })}
          />
          <label className="flex shrink-0 items-center gap-1 text-xs text-ink-soft">
            <input
              type="checkbox"
              disabled={!canManage}
              className="accent-ink"
              checked={l.enabled}
              onChange={(e) => update(i, { enabled: e.target.checked })}
            />
            Shown
          </label>
          {canManage && (
            <button
              type="button"
              onClick={() => remove(i)}
              aria-label="Remove link"
              className="shrink-0 text-ink-faint hover:text-clay"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      ))}
      {canManage && links.length < 12 && (
        <button
          type="button"
          onClick={() => onChange([...links, { ...BLANK_LINK }])}
          className="inline-flex items-center gap-1 text-xs font-medium text-ink-soft hover:text-ink"
        >
          <Plus size={13} /> Add link
        </button>
      )}
    </div>
  );
}
