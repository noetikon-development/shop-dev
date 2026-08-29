"use server";

import { revalidatePath } from "next/cache";
import {
  getCustomerAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultShippingAddress,
  setDefaultBillingAddress,
  type AddressResult,
  type AddressDTO,
  type FieldErrors,
} from "@/lib/addresses";

/**
 * The only address surface exposed to the browser. Every function delegates to
 * src/lib/addresses.ts, which resolves the authenticated customer server-side
 * and verifies ownership before any write. No userId, address ownership, or
 * default flag is trusted from the client.
 */

export type AddressFormState = {
  ok?: boolean;
  error?: string;
  fieldErrors?: FieldErrors;
  addresses?: AddressDTO[];
};

function revalidate() {
  revalidatePath("/account/addresses");
  revalidatePath("/account");
}

function formToInput(formData: FormData) {
  const s = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v : "";
  };
  const b = (k: string) => {
    const v = formData.get(k);
    return v === "on" || v === "true" || v === "1";
  };
  return {
    label: s("label"),
    firstName: s("firstName"),
    lastName: s("lastName"),
    company: s("company"),
    phone: s("phone"),
    line1: s("line1"),
    line2: s("line2"),
    barangay: s("barangay"),
    city: s("city"),
    province: s("province"),
    region: s("region"),
    postalCode: s("postalCode"),
    country: s("country") || "PH",
    defaultShipping: b("defaultShipping"),
    defaultBilling: b("defaultBilling"),
  };
}

function toState(res: AddressResult): AddressFormState {
  if (res.ok) return { ok: true, addresses: res.addresses };
  return { ok: false, error: res.error, fieldErrors: res.fieldErrors };
}

export async function getAddressesAction(): Promise<AddressDTO[]> {
  return getCustomerAddresses();
}

export async function createAddressAction(
  _prev: AddressFormState,
  formData: FormData,
): Promise<AddressFormState> {
  const res = await createAddress(formToInput(formData));
  if (res.ok) revalidate();
  return toState(res);
}

export async function updateAddressAction(
  _prev: AddressFormState,
  formData: FormData,
): Promise<AddressFormState> {
  const id = formData.get("id");
  if (typeof id !== "string" || !id) {
    return { ok: false, error: "That address wasn’t found." };
  }
  const res = await updateAddress(id, formToInput(formData));
  if (res.ok) revalidate();
  return toState(res);
}

export async function deleteAddressAction(id: string): Promise<AddressFormState> {
  const res = await deleteAddress(id);
  if (res.ok) revalidate();
  return toState(res);
}

export async function setDefaultShippingAction(id: string): Promise<AddressFormState> {
  const res = await setDefaultShippingAddress(id);
  if (res.ok) revalidate();
  return toState(res);
}

export async function setDefaultBillingAction(id: string): Promise<AddressFormState> {
  const res = await setDefaultBillingAddress(id);
  if (res.ok) revalidate();
  return toState(res);
}
