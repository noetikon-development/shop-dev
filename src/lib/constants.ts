export const SITE = {
  name: "AXIARO",
  /** Brand name as shown in browser/site labels and page titles. */
  brand: "Axiaro",
  tagline: "Considered things for everyday living",
  description:
    "AXIARO is a modern homeware and lifestyle store — furniture, kitchen, textiles and wardrobe essentials, designed to last and priced fairly.",
};

export const FREE_SHIPPING_THRESHOLD = 250000; // ₱2,500 in centavos
export const STANDARD_SHIPPING_FEE = 12900; // ₱129
export const EXPRESS_SHIPPING_FEE = 24900; // ₱249

export const SHIPPING_METHODS = [
  {
    id: "standard",
    label: "Standard delivery",
    detail: "3–7 business days",
    fee: STANDARD_SHIPPING_FEE,
  },
  {
    id: "express",
    label: "Express delivery",
    detail: "1–3 business days",
    fee: EXPRESS_SHIPPING_FEE,
  },
] as const;

export const PAYMENT_METHODS = [
  { id: "COD", label: "Cash on delivery", detail: "Pay the courier when your order arrives" },
  { id: "CARD", label: "Credit / debit card", detail: "Visa, Mastercard, JCB" },
  { id: "GCASH", label: "GCash", detail: "Pay via your GCash wallet" },
] as const;

export const ORDER_STATUS_FLOW = [
  "PENDING",
  "PAID",
  "PROCESSING",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const;

export const ORDER_STATUS_META: Record<
  string,
  { label: string; description: string; tone: "neutral" | "progress" | "positive" | "negative" }
> = {
  PENDING: { label: "Order placed", description: "We’ve received your order", tone: "neutral" },
  PAID: { label: "Payment confirmed", description: "Payment received", tone: "progress" },
  PROCESSING: { label: "Preparing", description: "Your order is being packed", tone: "progress" },
  SHIPPED: { label: "Shipped", description: "Handed to the courier", tone: "progress" },
  OUT_FOR_DELIVERY: {
    label: "Out for delivery",
    description: "Arriving today",
    tone: "progress",
  },
  DELIVERED: { label: "Delivered", description: "Order completed", tone: "positive" },
  CANCELLED: { label: "Cancelled", description: "This order was cancelled", tone: "negative" },
};

export const PRODUCT_BADGES: Record<string, { label: string; className: string }> = {
  new: { label: "New", className: "bg-ink text-paper" },
  bestseller: { label: "Bestseller", className: "bg-sage text-white" },
  sale: { label: "Sale", className: "bg-sale text-white" },
  "limited": { label: "Limited", className: "bg-clay text-white" },
  "low-stock": { label: "Low stock", className: "bg-white text-sale border border-sale" },
};

export const SORT_OPTIONS = [
  { id: "relevance", label: "Most relevant" },
  { id: "newest", label: "Newest" },
  { id: "price-asc", label: "Price: low to high" },
  { id: "price-desc", label: "Price: high to low" },
  { id: "rating", label: "Top rated" },
  { id: "bestselling", label: "Best selling" },
] as const;

export type SortId = (typeof SORT_OPTIONS)[number]["id"];
