import { NextResponse } from "next/server";
import { GoogleGenAI } from "@google/genai";

import { HttpError, runDailyJobs, serverDatabase, serverEnvironment } from "@/lib/app-server";
import { sendSecretaryBriefing } from "@/lib/secretary-briefing";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  try {
    const result = await runDailyJobs(request);

    // Secretary daily briefing — only when there are open tasks
    try {
      const env = serverEnvironment();
      if (env.GEMINI_API_KEY && env.LINE_CHANNEL_ACCESS_TOKEN) {
        const db = serverDatabase(env);
        const gemini = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

        // Get all active couples and groups
        const { data: couples } = await db
          .from("couples")
          .select("id");
        const { data: groups } = await db
          .from("groups")
          .select("id, couple_id")
          .is("archived_at", null);

        let briefingTasks = 0;
        if (couples && groups) {
          for (const couple of couples) {
            const coupleGroups = groups.filter((g) => g.couple_id === couple.id);
            for (const group of coupleGroups) {
              const briefing = await sendSecretaryBriefing({
                coupleId: couple.id,
                groupId: group.id,
                gemini,
                supabase: db,
              });
              briefingTasks += briefing.tasksFound;
            }
          }
        }

        return NextResponse.json({
          ...result,
          secretaryBriefingTasks: briefingTasks,
        });
      }
    } catch (briefingError) {
      console.error("Secretary briefing failed", {
        error: briefingError instanceof Error ? briefingError.message : "unknown",
      });
    }

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof HttpError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Daily job failed", { error: error instanceof Error ? error.name : "unknown" });
    return NextResponse.json({ error: "Daily job failed" }, { status: 500 });
  }
}
