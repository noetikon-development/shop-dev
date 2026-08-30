import { redirect } from "next/navigation";

/** The wishlist moved under the account area in Step 15. */
export default function LegacyWishlistPage() {
  redirect("/account/wishlist");
}
