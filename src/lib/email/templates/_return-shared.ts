import { esc } from "@/lib/email/html";

/**
 * Shared bits for the Step 21 P3 return / RMA emails. Every dynamic value is
 * `esc()`-escaped here so individual templates can't forget.
 */

export type ReturnEmailItem = {
  name: string;
  variantLabel: string | null;
  quantity: number;
};

/** An escaped "2 × Aro Sofa (Storm)" list as a paragraph of <br>-joined lines. */
export function returnItemsHtml(items: ReturnEmailItem[]): string {
  const lines = items.map(
    (i) => `${i.quantity} × ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`,
  );
  return `<p style="margin:0 0 18px;color:#5b564f;font-size:13px;line-height:1.7;">${lines
    .map((l) => esc(l))
    .join("<br>")}</p>`;
}

export function returnItemsText(items: ReturnEmailItem[]): string[] {
  return items.map(
    (i) => `- ${i.quantity} x ${i.name}${i.variantLabel ? ` (${i.variantLabel})` : ""}`,
  );
}
