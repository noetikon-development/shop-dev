import type { Metadata } from "next";
import { Package, Search } from "lucide-react";
import { getOrderByNumber } from "@/lib/data";
import { OrderDetail } from "@/components/order/order-detail";

export const metadata: Metadata = { title: "Track your order" };

export default async function TrackPage({ searchParams }: PageProps<"/track">) {
  const sp = await searchParams;
  const orderNumber = typeof sp.order === "string" ? sp.order.trim() : "";
  const email = typeof sp.email === "string" ? sp.email.trim().toLowerCase() : "";

  const order = orderNumber ? await getOrderByNumber(orderNumber) : null;
  const emailMatches = order && (!email || order.email.toLowerCase() === email);
  const showResult = order && emailMatches;
  const notFoundMsg =
    orderNumber && (!order || !emailMatches)
      ? "We couldn’t find an order with those details. Check the order number and the email used at checkout."
      : null;

  return (
    <div className="container-page py-10">
      <div className="mx-auto max-w-xl text-center">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-sunken">
          <Package size={22} className="text-ink-soft" />
        </div>
        <h1 className="mt-4 text-3xl">Track your order</h1>
        <p className="mt-2 text-sm text-ink-soft">
          Enter your order number and the email you used at checkout.
        </p>

        <form method="get" className="mt-6 grid gap-3 text-left sm:grid-cols-[1fr_1fr_auto]">
          <input
            name="order"
            defaultValue={orderNumber}
            required
            placeholder="AX-XXXXXX-XXXX"
            className="field"
            aria-label="Order number"
          />
          <input
            name="email"
            type="email"
            defaultValue={email}
            placeholder="Email address"
            className="field"
            aria-label="Email address"
          />
          <button className="btn btn-primary">
            <Search size={15} /> Track
          </button>
        </form>

        {notFoundMsg && (
          <p className="mt-4 rounded-sm bg-clay-50 px-3 py-2 text-sm text-clay">{notFoundMsg}</p>
        )}
      </div>

      {showResult && (
        <div className="mx-auto mt-12 max-w-4xl">
          <OrderDetail order={order} />
        </div>
      )}
    </div>
  );
}
