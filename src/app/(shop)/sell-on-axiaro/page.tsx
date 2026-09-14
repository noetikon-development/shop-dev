import type { Metadata } from "next";
import Link from "next/link";
import { CheckCircle2, ClipboardCheck, Rocket, Store } from "lucide-react";
import { getDefaultCommissionBps } from "@/lib/marketplace/commission-config";
import { buttonClasses } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Sell on Axiaro",
  description: "Apply to become an Axiaro marketplace seller.",
};

const STEPS = [
  { icon: ClipboardCheck, title: "Apply", body: "Tell us your store name and how customers can reach you." },
  { icon: CheckCircle2, title: "Review", body: "We review every application — usually within a few business days." },
  { icon: Store, title: "Approved", body: "You'll get an email the moment a decision is made." },
  { icon: Rocket, title: "Activate & sell", body: "Claim your seller account and start listing products." },
];

export default async function SellOnAxiaroPage() {
  // Public, read-only, no auth required — commission comes from the same CMS
  // setting createSeller() itself seeds a new seller's rate from, so this
  // page can never advertise a number that doesn't match what an approved
  // seller actually gets.
  const commissionBps = await getDefaultCommissionBps();
  const commissionLabel = `${(commissionBps / 100).toFixed(2)}%`;

  return (
    <div className="container-page py-10">
      <p className="eyebrow">Sell on Axiaro</p>
      <h1 className="mt-2 max-w-2xl text-title sm:text-display">
        Reach more customers, on a store they already trust
      </h1>
      <p className="mt-3 max-w-xl text-ink-soft">
        Axiaro's marketplace lets independent sellers list products alongside our own catalog.
        You keep control of your inventory and pricing — we bring the customers, checkout, and
        support.
      </p>

      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/sell-on-axiaro/apply" className={buttonClasses({ size: "lg" })}>
          Apply to Sell on Axiaro
        </Link>
        <Link
          href="/sell-on-axiaro/status"
          className={buttonClasses({ variant: "outline", size: "lg" })}
        >
          Already applied? Check your status
        </Link>
      </div>

      <div className="mt-12 grid gap-4 sm:grid-cols-3">
        <div className="card-surface p-5">
          <p className="font-display text-lg">Simple commission</p>
          <p className="mt-2 text-sm text-ink-soft">
            Axiaro takes a flat <span className="font-medium text-ink">{commissionLabel}</span> commission
            on each sale. No listing fees, no monthly subscription.
          </p>
        </div>
        <div className="card-surface p-5">
          <p className="font-display text-lg">What you'll need</p>
          <p className="mt-2 text-sm text-ink-soft">
            An Axiaro account, a store name, and a support email your customers can reach you at.
          </p>
        </div>
        <div className="card-surface p-5">
          <p className="font-display text-lg">You stay in control</p>
          <p className="mt-2 text-sm text-ink-soft">
            You manage your own listings and fulfil your own orders through the seller portal.
          </p>
        </div>
      </div>

      <section className="mt-12">
        <h2 className="text-subtitle">How it works</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {STEPS.map((step, i) => (
            <div key={step.title} className="card-surface p-5">
              <div className="flex items-center gap-2 text-ink-faint">
                <step.icon size={18} />
                <span className="text-meta">Step {i + 1}</span>
              </div>
              <p className="mt-2 font-display text-lg">{step.title}</p>
              <p className="mt-1 text-sm text-ink-soft">{step.body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
