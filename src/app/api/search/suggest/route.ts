import { NextResponse } from "next/server";
import { searchSuggestions } from "@/lib/data";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q") ?? "";
  if (q.trim().length < 2) return NextResponse.json({ results: [] });
  const results = await searchSuggestions(q, 6);
  return NextResponse.json({ results });
}
