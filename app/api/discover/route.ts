import { NextResponse } from "next/server";
import { discoverTopics } from "@/lib/extract";

export async function POST(req: Request) {
  const { categories, perCategoryLimit, totalLimit } = await req.json();
  if (!categories || typeof categories !== "string") {
    return NextResponse.json({ error: "categories is required" }, { status: 400 });
  }
  try {
    const result = await discoverTopics(categories, { perCategoryLimit, totalLimit });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "discovery failed" },
      { status: 500 }
    );
  }
}
