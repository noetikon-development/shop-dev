import type { Metadata } from "next";
import { requireUser } from "@/lib/auth";
import { getCustomerAddresses } from "@/lib/addresses";
import { AddressManager } from "@/components/account/address-manager";

export const metadata: Metadata = { title: "Addresses" };

export default async function AddressesPage() {
  await requireUser("/account/addresses");
  const addresses = await getCustomerAddresses();

  return <AddressManager addresses={addresses} />;
}
