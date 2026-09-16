import { NextResponse } from "next/server";
import { extractTopic, type Topic } from "@/lib/extract";

export async function POST(req: Request) {
  const { topic } = (await req.json()) as { topic: Topic };
  if (!topic?.title || !topic?.url || !topic?.category) {
    return NextResponse.json({ error: "topic {title,url,category} is required" }, { status: 400 });
  }
  const result = await extractTopic(topic);
  return NextResponse.json(result);
}
