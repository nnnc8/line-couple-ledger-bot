import { NextResponse } from "next/server";

import { HttpError, runDailyJobs } from "@/lib/app-server";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    return NextResponse.json(await runDailyJobs(request));
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Daily job failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "Daily job failed" }, { status: 500 });
  }
}
