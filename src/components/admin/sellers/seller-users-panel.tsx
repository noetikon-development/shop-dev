"use client";

import { useEffect, useRef } from "react";
import { Loader2 } from "lucide-react";
import {
  addSellerUserAction,
  setSellerUserRoleAction,
  setSellerUserStatusAction,
  type SellerAdminActionState,
} from "@/lib/admin/sellers/actions";
import { FormField, Select, notify, usePersistentAction } from "@/components/admin/ui";

type Member = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  createdAt: string;
};

const ROLES = ["OWNER", "MANAGER", "STAFF"];

export function SellerUsersPanel({ sellerId, users }: { sellerId: string; users: Member[] }) {
  const add = usePersistentAction<SellerAdminActionState>(addSellerUserAction, {});
  const role = usePersistentAction<SellerAdminActionState>(setSellerUserRoleAction, {});
  const stat = usePersistentAction<SellerAdminActionState>(setSellerUserStatusAction, {});
  const addFormRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (add.state.ok) {
      notify.success(add.state.message ?? "Member added");
      addFormRef.current?.reset();
    }
    if (add.state.error) notify.error(add.state.error);
  }, [add.state]);
  useEffect(() => {
    if (role.state.ok && role.state.message) notify.success(role.state.message);
    if (role.state.error) notify.error(role.state.error);
  }, [role.state]);
  useEffect(() => {
    if (stat.state.ok && stat.state.message) notify.success(stat.state.message);
    if (stat.state.error) notify.error(stat.state.error);
  }, [stat.state]);

  const submitRole = (sellerUserId: string, value: string) => {
    const fd = new FormData();
    fd.set("sellerId", sellerId);
    fd.set("sellerUserId", sellerUserId);
    fd.set("role", value);
    role.dispatch(fd);
  };
  const submitStatus = (sellerUserId: string, value: "ACTIVE" | "DISABLED") => {
    const fd = new FormData();
    fd.set("sellerId", sellerId);
    fd.set("sellerUserId", sellerUserId);
    fd.set("status", value);
    stat.dispatch(fd);
  };

  return (
    <div className="space-y-4">
      {users.length === 0 ? (
        <p className="text-sm text-ink-faint">No members yet.</p>
      ) : (
        <ul className="divide-y divide-line-soft rounded-sm border border-line">
          {users.map((u) => (
            <li key={u.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-ink">{u.name ?? u.email}</span>
                {u.name && <span className="block truncate text-xs text-ink-faint">{u.email}</span>}
              </span>
              <Select
                value={u.role}
                onChange={(e) => submitRole(u.id, e.target.value)}
                disabled={role.pending || u.status === "DISABLED"}
                className="w-32"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </Select>
              {u.status === "DISABLED" ? (
                <button
                  type="button"
                  onClick={() => submitStatus(u.id, "ACTIVE")}
                  disabled={stat.pending}
                  className="btn btn-ghost py-1 text-xs"
                >
                  Enable
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => submitStatus(u.id, "DISABLED")}
                  disabled={stat.pending}
                  className="btn btn-ghost py-1 text-xs text-clay"
                >
                  Disable
                </button>
              )}
              <span className="w-16 text-right text-xs text-ink-faint">{u.status.toLowerCase()}</span>
            </li>
          ))}
        </ul>
      )}

      <form
        ref={addFormRef}
        onSubmit={add.onSubmit}
        className="grid gap-3 rounded-sm border border-line p-3 sm:grid-cols-[1fr_140px_auto] sm:items-end"
      >
        <input type="hidden" name="sellerId" value={sellerId} />
        <FormField label="Add member by email" htmlFor="su-email" hint="Must already have an Axiaro account.">
          <input id="su-email" name="email" type="email" required className="field text-sm" />
        </FormField>
        <FormField label="Role" htmlFor="su-role">
          <Select id="su-role" name="role" defaultValue="STAFF">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
        </FormField>
        <button type="submit" disabled={add.pending} className="btn btn-primary py-2 text-sm">
          {add.pending && <Loader2 size={14} className="animate-spin" />}
          Add
        </button>
      </form>
      <p className="text-xs text-ink-faint">
        Inviting someone without an account yet needs a seller-invite email flow — not built. Have them register first.
      </p>
    </div>
  );
}
