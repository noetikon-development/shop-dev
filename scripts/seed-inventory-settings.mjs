// Non-destructive seed for Inventory + StoreSetting (does NOT touch the catalogue).
// Run:  node --env-file=.env scripts/seed-inventory-settings.mjs
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient({ datasourceUrl: process.env.DIRECT_URL });

const variants = await prisma.variant.findMany({ select: { id: true, sku: true, stock: true } });
for (const v of variants) {
  await prisma.inventory.upsert({
    where: { variantId: v.id },
    update: { quantity: v.stock, sku: v.sku },
    create: { variantId: v.id, sku: v.sku, quantity: v.stock, reserved: 0, reorderPoint: 3 },
  });
}
console.log(`Inventory: ${variants.length} records`);

const STORE_SETTINGS = [
  { key: "site.name", value: "AXIARO", type: "string", label: "Legal / system name", group: "brand" },
  { key: "site.brand", value: "Axiaro", type: "string", label: "Display brand name", group: "brand" },
  { key: "site.tagline", value: "Considered things for everyday living", type: "string", label: "Tagline", group: "brand" },
  { key: "site.description", value: "AXIARO is a modern homeware and lifestyle store — furniture, kitchen, textiles and wardrobe essentials, designed to last and priced fairly.", type: "string", label: "Meta description", group: "brand" },
  { key: "currency", value: "PHP", type: "string", label: "Currency", group: "checkout" },
  { key: "shipping.freeThreshold", value: 250000, type: "number", label: "Free shipping threshold (centavos)", group: "checkout" },
  { key: "shipping.standardFee", value: 12900, type: "number", label: "Standard shipping fee (centavos)", group: "checkout" },
  { key: "shipping.expressFee", value: 24900, type: "number", label: "Express shipping fee (centavos)", group: "checkout" },
  { key: "shipping.methods", value: [
    { id: "standard", label: "Standard delivery", detail: "3–7 business days", fee: 12900 },
    { id: "express", label: "Express delivery", detail: "1–3 business days", fee: 24900 },
  ], type: "json", label: "Shipping methods", group: "checkout" },
  { key: "payment.methods", value: [
    { id: "COD", label: "Cash on delivery", detail: "Pay the courier when your order arrives" },
    { id: "CARD", label: "Credit / debit card", detail: "Visa, Mastercard, JCB" },
    { id: "GCASH", label: "GCash", detail: "Pay via your GCash wallet" },
  ], type: "json", label: "Payment methods", group: "checkout" },
  { key: "returns.windowDays", value: 30, type: "number", label: "Return window (days)", group: "policy" },
  { key: "guarantee.furnitureYears", value: 10, type: "number", label: "Furniture frame guarantee (years)", group: "policy" },
];
for (const s of STORE_SETTINGS) {
  const value = s.type === "string" ? String(s.value) : JSON.stringify(s.value);
  await prisma.storeSetting.upsert({
    where: { key: s.key },
    update: { value, type: s.type, label: s.label, group: s.group },
    create: { key: s.key, value, type: s.type, label: s.label, group: s.group },
  });
}
console.log(`Store settings: ${STORE_SETTINGS.length}`);

await prisma.$disconnect();
