import { GoogleGenAI } from "@google/genai";
import { LineBotClient } from "@line/bot-sdk";
import { NextResponse } from "next/server";

import { serverDatabase, serverEnvironment } from "@/lib/server-runtime";
import { safeSecretEqual } from "@/lib/security";
import { dispatchV2LineInbox } from "@/lib/v2-line-inbox-dispatch";
import { dispatchV2NotificationOutbox } from "@/lib/v2-outbox-dispatch";
import { isV2IncidentBootstrapOnly, V2_FINANCIAL_MAINTENANCE_MESSAGE } from "@/lib/v2-incident-freeze";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const env = serverEnvironment();
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "")
    ?? new URL(request.url).searchParams.get("secret")
    ?? "";
  if (!safeSecretEqual(supplied, env.CRON_SECRET)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (isV2IncidentBootstrapOnly(env)) {
    return NextResponse.json({ error: V2_FINANCIAL_MAINTENANCE_MESSAGE }, { status: 503 });
  }
  const db = serverDatabase(env);
  const dependencies = {
    lineClient: LineBotClient.fromChannelAccessToken({ channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN }),
    supabase: db,
    gemini: new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }),
    setupCode: env.COUPLE_SETUP_CODE,
  };
  const [inbox, notifications] = await Promise.all([
    env.V2_LINE_INBOX_ENABLED === "1" ? dispatchV2LineInbox(dependencies, 50) : Promise.resolve(0),
    env.V2_LEDGER_ENABLED === "1" ? dispatchV2NotificationOutbox({ db, lineChannelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN }, 50) : Promise.resolve(0),
  ]);
  return NextResponse.json({ inbox, notifications });
}
