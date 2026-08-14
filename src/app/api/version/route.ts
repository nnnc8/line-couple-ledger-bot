import { NextResponse } from "next/server";

import { getBuildVersion } from "@/lib/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json(getBuildVersion(), {
    headers: { "cache-control": "no-store" },
  });
}
