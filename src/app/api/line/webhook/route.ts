import { GoogleGenAI } from "@google/genai";
import { LineBotClient, validateSignature, type webhook } from "@line/bot-sdk";
import { createClient } from "@supabase/supabase-js";
import { after, NextResponse } from "next/server";
import { z } from "zod";

import { handleLineEvent } from "@/lib/line-webhook-service";
import { withTx } from "@/lib/db/tx";
import { dispatchV2LineInbox } from "@/lib/v2-line-inbox-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { envSchema as sharedEnvSchema } from "@/lib/server-runtime";

export const envSchema = sharedEnvSchema.extend({
  LINE_CHANNEL_SECRET: z.string().min(1),
});

const callbackSchema = z.object({
  events: z.array(z.record(z.string(), z.unknown())),
});

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  if (rawBody.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  const environment = envSchema.safeParse(process.env);
  if (!environment.success) {
    return NextResponse.json({ error: "Server is not configured" }, { status: 500 });
  }

  const signature = request.headers.get("x-line-signature");
  if (
    !signature ||
    !validateSignature(
      rawBody,
      environment.data.LINE_CHANNEL_SECRET,
      signature,
    )
  ) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let callback: z.infer<typeof callbackSchema>;
  try {
    callback = callbackSchema.parse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ error: "Invalid webhook" }, { status: 400 });
  }

  const lineClient = LineBotClient.fromChannelAccessToken({
    channelAccessToken: environment.data.LINE_CHANNEL_ACCESS_TOKEN,
  });
  const dependencies = {
    lineClient,
    supabase: createClient(
      environment.data.SUPABASE_URL,
      environment.data.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    ),
    gemini: new GoogleGenAI({ apiKey: environment.data.GEMINI_API_KEY }),
    setupCode: environment.data.COUPLE_SETUP_CODE,
  };

  if (environment.data.V2_LINE_INBOX_ENABLED === "1") {
    try {
      await withTx(async (client) => {
        for (const event of callback.events) {
          const source = typeof event === "object" && event !== null && "source" in event
            ? (event as { source?: unknown }).source
            : null;
          const sourceUserId = source && typeof source === "object" && "userId" in source
            ? String((source as { userId: unknown }).userId)
            : null;
          await client.query(
            `insert into ledger_v2.line_inbox
              (channel, webhook_event_id, source_user_id, payload)
             values ($1, $2, $3, $4::jsonb)
             on conflict (provider, channel, webhook_event_id) do nothing`,
            ["production", event.webhookEventId, sourceUserId, JSON.stringify(event)],
          );
        }
      });
    } catch (error) {
      console.error("LINE inbox write failed", { error: error instanceof Error ? error.name : "unknown" });
      return NextResponse.json({ error: "Inbox unavailable" }, { status: 503 });
    }
    after(async () => {
      try {
        await dispatchV2LineInbox(dependencies);
      } catch (error) {
        console.error("V2 LINE inbox dispatch failed", { error: error instanceof Error ? error.name : "unknown" });
      }
    });
    return NextResponse.json({ ok: true });
  }
  after(async () => {
    await Promise.allSettled(
      callback.events.map((event) =>
        handleLineEvent(event as unknown as webhook.Event, dependencies),
      ),
    );
  });
  return NextResponse.json({ ok: true });
}
