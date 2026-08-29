import { NextResponse } from "next/server";
import { getProductCardsBySlugs } from "@/lib/data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const slugs = (searchParams.get("slugs") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  const products = await getProductCardsBySlugs(slugs);
  return NextResponse.json({ products });
}
