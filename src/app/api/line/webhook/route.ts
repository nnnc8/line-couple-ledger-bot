import { GoogleGenAI } from "@google/genai";
import { LineBotClient, validateSignature, type webhook } from "@line/bot-sdk";
import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { z } from "zod";

import { handleLineEvent } from "@/lib/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const envSchema = z.object({
  LINE_CHANNEL_SECRET: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  COUPLE_SETUP_CODE: z.string().min(20),
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

  const dependencies = {
    lineClient: LineBotClient.fromChannelAccessToken({
      channelAccessToken: environment.data.LINE_CHANNEL_ACCESS_TOKEN,
    }),
    supabase: createClient(
      environment.data.SUPABASE_URL,
      environment.data.SUPABASE_SECRET_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } },
    ),
    gemini: new GoogleGenAI({ apiKey: environment.data.GEMINI_API_KEY }),
    setupCode: environment.data.COUPLE_SETUP_CODE,
  };

  await Promise.allSettled(
    callback.events.map((event) =>
      handleLineEvent(event as unknown as webhook.Event, dependencies),
    ),
  );
  return NextResponse.json({ ok: true });
}
