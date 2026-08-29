import type { Metadata } from "next";
import { requirePermission } from "@/lib/admin/rbac";
import { listShippingMethods } from "@/lib/admin/shipping";
import { getSupportedShippingCountries, getFreeShippingThreshold } from "@/lib/shipping";
import { PageHeader, Card } from "@/components/admin/ui";
import { ShippingMethods } from "@/components/admin/shipping/shipping-methods";
import { formatPrice } from "@/lib/utils";
import { countryName } from "@/lib/countries";

export const metadata: Metadata = { title: "Shipping" };

export default async function AdminShippingPage() {
  const admin = await requirePermission("view_shipping");
  const canManage = admin.isSuperAdmin || admin.permissions.has("manage_shipping");

  const [methods, countries, freeThreshold] = await Promise.all([
    listShippingMethods(),
    getSupportedShippingCountries(),
    getFreeShippingThreshold(),
  ]);

  return (
    <div>
      <PageHeader
        title="Shipping"
        description="Delivery methods and rates shown at checkout. Every order snapshots the method and amount it used, so changes here never affect historical orders."
      />

      <Card className="mb-5 text-sm">
        <div className="flex flex-wrap gap-x-8 gap-y-2 text-ink-soft">
          <span>
            Delivers to:{" "}
            <span className="font-medium text-ink">
              {countries.map((c) => countryName(c)).join(", ")}
            </span>
          </span>
          <span>
            Free shipping over:{" "}
            <span className="font-medium text-ink">
              {freeThreshold > 0 ? formatPrice(freeThreshold) : "—"}
            </span>
          </span>
        </div>
        <p className="mt-2 text-xs text-ink-faint">
          The supported countries and free-shipping threshold are edited under Settings ·
          Shipping. Courier integration and delivery zones are a later step.
        </p>
      </Card>

      <ShippingMethods methods={methods} canManage={canManage} />
    </div>
  );
}
