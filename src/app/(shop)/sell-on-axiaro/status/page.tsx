import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { getSellerApplicationStatus } from "@/lib/seller-onboarding/repository";
import { ClaimOwnerButton } from "@/components/seller-onboarding/claim-owner-button";
import { buttonClasses } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Application status",
  description: "Check the status of your Axiaro seller application.",
};

export default async function SellerApplicationStatusPage() {
  // Existing-account requirement — same auth/redirect pattern every other
  // account-gated page uses.
  const user = await requireUser("/sell-on-axiaro/status");

  // Looked up ONLY by applicantUserId (the authenticated session's own id) —
  // never by supportEmail, displayName, slug, or anything from the URL/form.
  // There is no id of any kind read from the request here, so there is no
  // way to ask for someone else's application.
  const application = await getSellerApplicationStatus(user.id);

  return (
    <div className="container-page py-10">
      <p className="eyebrow">Sell on Axiaro</p>
      <h1 className="mt-2 max-w-2xl text-title sm:text-display">Application status</h1>

      <div className="mt-8 max-w-md">
        {!application && <NoApplication />}
        {application?.status === "PENDING" && <Pending app={application} />}
        {application?.status === "APPROVED" && <Approved app={application} />}
        {application?.status === "REJECTED" && <Rejected app={application} />}
        {application && !["PENDING", "APPROVED", "REJECTED"].includes(application.status) && (
          <Other app={application} />
        )}
      </div>
    </div>
  );
}

type App = NonNullable<Awaited<ReturnType<typeof getSellerApplicationStatus>>>;

function StatusCard({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-line-strong bg-surface p-6">
      <p className="font-display text-lg">{heading}</p>
      {children}
    </div>
  );
}

function NoApplication() {
  return (
    <StatusCard heading="You don't have a seller application yet">
      <p className="mt-2 text-sm text-ink-soft">
        Apply to start selling on Axiaro — we review every application and email you once
        there's a decision.
      </p>
      <Link href="/sell-on-axiaro/apply" className={buttonClasses({ className: "mt-4" })}>
        Apply to sell
      </Link>
    </StatusCard>
  );
}

function Pending({ app }: { app: App }) {
  return (
    <StatusCard heading={app.reopened ? "Your application is back under review" : "Application under review"}>
      <p className="mt-2 text-sm text-ink-soft">
        {app.reopened
          ? "An admin took another look and reopened your application. We'll email you once there's a decision."
          : "We've received your application and it's under review. We'll email you once there's a decision."}
      </p>
      <dl className="mt-4 space-y-1 text-sm">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-faint">Store name</dt>
          <dd>{app.displayName}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-faint">Submitted</dt>
          <dd>{formatDate(app.createdAt)}</dd>
        </div>
      </dl>
      {app.reopened && app.reason && (
        <div className="mt-4 rounded-sm border border-line bg-canvas px-3 py-2">
          <p className="text-xs font-medium text-ink-soft">Note from the review team</p>
          <p className="mt-1 text-sm">{app.reason}</p>
        </div>
      )}
    </StatusCard>
  );
}

function Approved({ app }: { app: App }) {
  // Neither branch below shows an invite id, a claim URL, or any SellerInvite
  // field — the button (ClaimOwnerButton) sends no id of any kind, and
  // "already activated" is a plain, static message.
  if (app.hasActiveMembership) {
    return (
      <StatusCard heading="Application approved">
        <p className="mt-2 text-sm text-ink-soft">
          Your seller account for{" "}
          <span className="font-medium text-ink">{app.displayName}</span> is already activated.
        </p>
        <a href="/seller" className="mt-4 inline-block text-sm font-medium underline">
          Go to Seller Portal
        </a>
      </StatusCard>
    );
  }

  return (
    <StatusCard heading="Application approved">
      <p className="mt-2 text-sm text-ink-soft">
        Your application for <span className="font-medium text-ink">{app.displayName}</span> was
        approved.{" "}
        {app.hasPendingInvite
          ? "Activate your account to start selling."
          : "Account activation is the next step — we'll email you with what to do next."}
      </p>
      {app.hasPendingInvite && <ClaimOwnerButton />}
    </StatusCard>
  );
}

function Rejected({ app }: { app: App }) {
  return (
    <StatusCard heading="Application wasn't approved">
      <p className="mt-2 text-sm text-ink-soft">
        Your application for {app.displayName} wasn't approved this time.
      </p>
      {app.reason && (
        <div className="mt-4 rounded-sm border border-line bg-canvas px-3 py-2">
          <p className="text-xs font-medium text-ink-soft">Reason</p>
          <p className="mt-1 text-sm">{app.reason}</p>
        </div>
      )}
    </StatusCard>
  );
}

function Other({ app }: { app: App }) {
  return (
    <StatusCard heading="Application status">
      <p className="mt-2 text-sm text-ink-soft">
        Your application for {app.displayName} is currently {app.status.toLowerCase()}. Contact
        support if you have questions.
      </p>
    </StatusCard>
  );
}
