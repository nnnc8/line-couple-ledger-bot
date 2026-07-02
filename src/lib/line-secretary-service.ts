import { z } from "zod";
import { serverEnvironment } from "./server-runtime";
import { runSecretaryLoop } from "./secretary-agent";
import { notifyPartner as pushNotifyPartner } from "./secretary-push";
import { SecretaryService } from "./secretary-service";
import { pendingActionService, agentChatService } from "./services";

export interface LineUser {
  id: string;
  couple_id: number;
  role: "owner" | "partner";
  line_user_id: string;
}

export interface LineSecretaryDependencies {
  lineClient: {
    replyMessage(params: { replyToken: string; messages: any[] }): Promise<any>;
    getMessageContent(messageId: string): Promise<any>;
    pushMessage(params: { to: string; messages: any[] }): Promise<any>;
  };
  supabase: any;
  gemini: any;
}

const actionResultSchema = z.object({
  result: z.enum([
    "confirmed",
    "cancelled",
    "expired",
    "stale",
    "not_found",
    "already_done",
  ]),
  action_type: z.string().nullable().optional(),
  created_count: z.number().int().optional(),
});

const secretaryService = new SecretaryService();

export async function runLineSecretaryTurn(input: {
  text: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (text: string) => Promise<void>;
  imageData?: { imageData: string; mimeType: string };
}): Promise<void> {
  const { text, user, dependencies, reply, imageData } = input;
  const groupId = await getActiveGroupId(dependencies.supabase, user);

  const toolCtx = {
    db: dependencies.supabase,
    groupId,
    userId: user.id,
    coupleId: user.couple_id,
  };

  const agentDeps = {
    gemini: dependencies.gemini,
    supabase: dependencies.supabase,
  };

  // Get partner user info for secretary context
  const partner = await findPartner(dependencies.supabase, user);

  // Load couple-level session
  const { data: lastSession } = await dependencies.supabase
    .from("secretary_sessions")
    .select("id")
    .eq("couple_id", user.couple_id)
    .eq("group_id", groupId)
    .order("last_active_at", { ascending: false })
    .limit(1)
    .single();

  const sessionId = lastSession?.id ?? null;

  try {
    const userName = "你";
    const partnerName = "另一半";

    const serverContext = {
      env: serverEnvironment(),
      db: dependencies.supabase,
      user: {
        id: user.id,
        couple_id: user.couple_id,
        line_user_id: user.line_user_id,
        role: user.role,
      },
    };
    const workflowResult = await secretaryService.run({
      initialInput: {
        text,
        ...(imageData ? { imageData: imageData.imageData, mimeType: imageData.mimeType } : {}),
      },
      sessionId,
      runLoop: (inputMsg, currentSessionId) =>
        runSecretaryLoop(
          inputMsg,
          currentSessionId,
          user.id,
          user.couple_id,
          userName,
          partnerName,
          toolCtx,
          agentDeps,
        ),
      executeAction: async (action) =>
        actionResultSchema.parse(await pendingActionService.executeAgentAction(serverContext, action)),
    });
    if (workflowResult.actionFailure) {
      const { actionResultMessage } = await import("./line-bot-shared");
      await reply(actionResultMessage(workflowResult.actionFailure));
      return;
    }

    await reply(workflowResult.reply);
    if (workflowResult.notifyPartner && workflowResult.partnerMessage && partner) {
      await pushNotifyPartner(dependencies.lineClient, dependencies.supabase, {
        targetUserId: partner.id,
        message: workflowResult.partnerMessage,
      });
    }
  } catch (error) {
    console.error("Secretary loop failed", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.slice(0, 500) : undefined,
      name: error instanceof Error ? error.name : typeof error,
    });
    await reply("抱歉，我暫時無法處理你的請求，請稍後再試。");
  }
}

export async function handleLineAudioTurn(input: {
  messageId: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (text: string) => Promise<void>;
}): Promise<void> {
  const { messageId, user, dependencies, reply } = input;
  try {
    const content = await dependencies.lineClient.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) {
        await reply("語音訊息太大，請傳短一點的語音。");
        return;
      }
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    const text = await agentChatService.transcribeAudio(bytes, "audio/x-m4a");
    if (!text) {
      await reply("沒聽清楚，可以再說一次或打字嗎？");
      return;
    }

    await runLineSecretaryTurn({
      text,
      user,
      dependencies,
      reply: async (assistantReply: string) => {
        await reply(`聽到：「${text}」\n${assistantReply}`);
      },
    });
  } catch (err) {
    console.error("Failed to process audio message:", err);
    await reply("語音處理失敗，請稍後再試或直接打字。");
  }
}

export async function handleLineImageTurn(input: {
  messageId: string;
  user: LineUser;
  dependencies: LineSecretaryDependencies;
  reply: (text: string) => Promise<void>;
}): Promise<void> {
  const { messageId, user, dependencies, reply } = input;
  try {
    const content = await dependencies.lineClient.getMessageContent(messageId);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of content) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > 10 * 1024 * 1024) {
        await reply("圖片太大，請傳小一點的圖片。");
        return;
      }
      chunks.push(buffer);
    }
    const bytes = Buffer.concat(chunks);
    const base64Image = bytes.toString("base64");

    // Determine MIME type from the first few bytes
    let mimeType = "image/jpeg"; // default
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      mimeType = "image/png";
    } else if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
      mimeType = "image/webp";
    }

    const text = "這是一張收據或發票照片。請分析圖片內容，提取商家名稱、日期、總金額，並判斷分類，然後呼叫 record_expense 工具記帳。如果圖片不是收據或發票，請告知使用者。";
    await runLineSecretaryTurn({
      text,
      user,
      dependencies,
      reply,
      imageData: { imageData: base64Image, mimeType },
    });
  } catch (err) {
    console.error("Failed to process image message:", err);
    await reply("圖片處理失敗，請稍後再試。");
  }
}

async function findPartner(
  supabase: any,
  user: LineUser,
): Promise<LineUser | null> {
  const { data, error } = await supabase
    .from("users")
    .select("id, couple_id, role, line_user_id")
    .eq("couple_id", user.couple_id)
    .neq("id", user.id)
    .maybeSingle();

  if (error || !data) return null;
  return data as LineUser;
}

async function getActiveGroupId(
  supabase: any,
  user: LineUser,
): Promise<string> {
  const { data } = await supabase
    .from("user_preferences")
    .select("active_group_id")
    .eq("user_id", user.id)
    .single();

  if (data) {
    return z.object({ active_group_id: z.string().uuid() }).parse(data).active_group_id;
  }

  // Fallback: get any group for this couple
  const { data: groups } = await supabase
    .from("groups")
    .select("id")
    .eq("couple_id", user.couple_id)
    .is("archived_at", null)
    .limit(1);

  if (groups?.length) {
    return z.object({ id: z.string().uuid() }).parse(groups[0]).id;
  }

  throw new Error("找不到可用群組");
}
