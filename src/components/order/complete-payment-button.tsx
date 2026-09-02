"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { startCheckoutPayment } from "@/lib/checkout-actions";

/**
 * Phase 6B — "Complete payment" for an order still `PENDING_PAYMENT`.
 *
 * Calls the server action, which resumes an in-flight PayMongo session or opens
 * a fresh one, then hands the browser to the hosted checkout page. It never
 * marks the order paid — that is the webhook's job (Phase 6C).
 */
export function CompletePaymentButton({
  orderNumber,
  label = "Complete payment",
}: {
  orderNumber: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function go() {
    if (busy) return;
    setBusy(true);
    const res = await startCheckoutPayment(orderNumber);
    if (res.ok) {
      window.location.assign(res.checkoutUrl);
      return; // keep the loading state until navigation
    }
    setBusy(false);
    toast.error(res.error);
  }

  return (
    <Button onClick={go} loading={busy}>
      {!busy && <CreditCard size={15} />}
      {busy ? "Opening payment…" : label}
    </Button>
  );
}
