/**
 * Daily Secretary Briefing.
 *
 * Runs via the daily cron job. Gathers open tasks, generates a summary,
 * and pushes it to both partners via LINE push messages.
 *
 * Only sends if there are open tasks — no spam.
 */

import { GoogleGenAI } from "@google/genai";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LineBotClient } from "@line/bot-sdk";

import { TaskService } from "./task-service";

export interface BriefingResult {
  tasksFound: number;
  messagesSent: number;
  summary: string;
}

/**
 * Generate and send a daily secretary briefing for one couple.
 */
export async function sendSecretaryBriefing(
  options: {
    coupleId: number;
    groupId: string;
    gemini: GoogleGenAI;
    supabase: SupabaseClient;
    lineClient?: Pick<LineBotClient, "pushMessage">;
  },
): Promise<BriefingResult> {
  const taskService = new TaskService(options.supabase);
  const tasks = await taskService.listOpenTasks({
    coupleId: options.coupleId,
    groupId: options.groupId,
    limit: 5,
  });

  if (tasks.length === 0) {
    return { tasksFound: 0, messagesSent: 0, summary: "沒有待處理任務" };
  }

  const taskListText = taskService.formatTaskList(tasks, "今天有這些事要處理：");

  // Get both users in this couple
  const { data: users } = await options.supabase
    .from("users")
    .select("id, line_user_id")
    .eq("couple_id", options.coupleId);

  if (!users || !options.lineClient) {
    return {
      tasksFound: tasks.length,
      messagesSent: 0,
      summary: taskListText,
    };
  }

  // Push to both users
  let messagesSent = 0;
  for (const user of users) {
    if (!user.line_user_id) continue;
    try {
      await options.lineClient.pushMessage({
        to: user.line_user_id,
        messages: [
          {
            type: "text",
            text: `📋 ${taskListText}\n\n打開 LIFF 查看更多：${process.env.APP_URL ?? ""}`,
          },
        ],
      });
      messagesSent++;
    } catch (error) {
      console.error("Secretary briefing push failed", {
        userId: user.id,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    tasksFound: tasks.length,
    messagesSent,
    summary: taskListText,
  };
}
