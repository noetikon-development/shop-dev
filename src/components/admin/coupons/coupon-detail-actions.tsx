"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Pencil } from "lucide-react";
import { ConfirmDialog, notify } from "@/components/admin/ui";
import {
  setCouponActiveAction,
  archiveCouponAction,
  unarchiveCouponAction,
} from "@/lib/admin/coupon-actions";

export function CouponDetailActions({
  id,
  active,
  archived,
  canManage,
}: {
  id: string;
  active: boolean;
  archived: boolean;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmArchive, setConfirmArchive] = useState(false);

  if (!canManage) return null;

  function run(action: () => Promise<{ ok?: boolean; error?: string }>, msg: string) {
    startTransition(async () => {
      const res = await action();
      if (res.ok) {
        notify.success(msg);
        setConfirmArchive(false);
        router.refresh();
      } else {
        notify.error(res.error ?? "That didn’t work.");
      }
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link href={`/admin/marketing/coupons/${id}/edit`} className="btn btn-outline py-2 text-sm">
        <Pencil size={13} /> Edit
      </Link>

      {archived ? (
        <button
          type="button"
          onClick={() => run(() => unarchiveCouponAction({ id }), "Coupon restored")}
          disabled={pending}
          className="btn btn-outline py-2 text-sm"
        >
          {pending && <Loader2 size={13} className="animate-spin" />}
          Restore from archive
        </button>
      ) : (
        <>
          <button
            type="button"
            onClick={() =>
              run(
                () => setCouponActiveAction({ id, active: !active }),
                active ? "Coupon deactivated" : "Coupon activated",
              )
            }
            disabled={pending}
            className="btn btn-outline py-2 text-sm"
          >
            {pending && <Loader2 size={13} className="animate-spin" />}
            {active ? "Deactivate" : "Activate"}
          </button>
          <button
            type="button"
            onClick={() => setConfirmArchive(true)}
            disabled={pending}
            className="btn btn-ghost py-2 text-sm text-clay"
          >
            Archive
          </button>
        </>
      )}

      <ConfirmDialog
        open={confirmArchive}
        onClose={() => !pending && setConfirmArchive(false)}
        onConfirm={() => run(() => archiveCouponAction({ id }), "Coupon archived")}
        title="Archive this coupon?"
        message="It stops working immediately and is hidden from the list and the promotions page. Past orders that used it are unaffected. You can restore it later."
        confirmLabel="Archive"
        pending={pending}
      />
    </div>
  );
}
