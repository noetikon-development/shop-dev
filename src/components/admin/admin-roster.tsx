"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { updateUserRoles, type RolesState } from "@/lib/admin/actions";

type Admin = {
  id: string;
  name: string | null;
  email: string;
  roleKeys: string[];
};

type RoleOption = { key: string; name: string };

function RoleEditor({
  admin,
  roleOptions,
}: {
  admin: Admin;
  roleOptions: RoleOption[];
}) {
  const [state, formAction, pending] = useActionState<RolesState, FormData>(
    updateUserRoles,
    {},
  );
  // Initial checkbox state from the server. The parent re-mounts this component
  // (via `key`) whenever the persisted role set changes, so this stays in sync
  // without an effect.
  const [selected, setSelected] = useState<Set<string>>(new Set(admin.roleKeys));

  const toastedFor = useRef<RolesState | null>(null);
  useEffect(() => {
    if (state === toastedFor.current) return;
    if (state.ok) toast.success(`Roles updated for ${admin.email}`);
    else if (state.error) toast.error(state.error);
    toastedFor.current = state;
  }, [state, admin.email]);

  const dirty =
    selected.size !== admin.roleKeys.length ||
    admin.roleKeys.some((k) => !selected.has(k));

  return (
    <form action={formAction} className="mt-2">
      <input type="hidden" name="userId" value={admin.id} />
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {roleOptions.map((r) => (
          <label key={r.key} className="inline-flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              name="roleKeys"
              value={r.key}
              checked={selected.has(r.key)}
              onChange={(e) => {
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(r.key);
                  else next.delete(r.key);
                  return next;
                });
              }}
            />
            {r.name}
          </label>
        ))}
      </div>
      <button
        type="submit"
        disabled={pending || !dirty}
        className="btn btn-outline mt-3 py-2 text-xs disabled:opacity-40"
      >
        {pending && <Loader2 size={13} className="animate-spin" />}
        Save roles
      </button>
    </form>
  );
}

export function AdminRoster({
  admins,
  roleOptions,
  currentUserId,
  canManage,
}: {
  admins: Admin[];
  roleOptions: RoleOption[];
  currentUserId: string;
  canManage: boolean;
}) {
  return (
    <ul className="mt-3 divide-y divide-line border-y border-line">
      {admins.map((a) => {
        const isSelf = a.id === currentUserId;
        return (
          <li key={a.id} className="py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <div>
                <p className="text-sm font-medium">
                  {a.name ?? a.email}
                  {isSelf && <span className="ml-2 text-xs text-ink-faint">you</span>}
                </p>
                <p className="text-xs text-ink-faint">{a.email}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {a.roleKeys.map((k) => (
                  <span
                    key={k}
                    className="rounded-xs bg-ink px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-paper"
                  >
                    {k.replace(/_/g, " ")}
                  </span>
                ))}
                {a.roleKeys.length === 0 && (
                  <span className="text-xs text-ink-faint">no roles</span>
                )}
              </div>
            </div>

            {canManage && !isSelf && (
              <RoleEditor
                key={`${a.id}:${a.roleKeys.join(",")}`}
                admin={a}
                roleOptions={roleOptions}
              />
            )}
            {canManage && isSelf && (
              <p className="mt-2 text-xs text-ink-faint">
                You can’t change your own roles.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}
