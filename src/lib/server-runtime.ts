import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { safeSecretEqual, signSession, verifySession } from "./security";
import { HttpError } from "./http-error";
import { claimUser } from "./claim-user";

export const SESSION_COOKIE = "couple_ledger_session";
const SESSION_SECONDS = 60 * 60 * 24 * 7;

export const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1),
  LINE_LOGIN_CHANNEL_ID: z.string().min(1),
  GEMINI_API_KEY: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_SECRET_KEY: z.string().min(1),
  COUPLE_SETUP_CODE: z.string().min(20),
  LIFF_SESSION_SECRET: z.string().min(32),
  APP_URL: z.url(),
  CRON_SECRET: z.string().min(16),
});

const userSchema = z.object({
  id: z.string().uuid(),
  couple_id: z.number().int(),
  line_user_id: z.string(),
  role: z.enum(["owner", "partner"]),
});

export type AppUser = z.infer<typeof userSchema>;

export interface ServerContext {
  env: z.infer<typeof envSchema>;
  db: SupabaseClient;
  user: AppUser;
}

export function serverEnvironment(): z.infer<typeof envSchema> {
  return envSchema.parse(process.env);
}

export function serverDatabase(env = serverEnvironment()): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function assertSameOrigin(request: Request, appUrl: string): void {
  if (request.headers.get("origin") !== new URL(appUrl).origin) {
    throw new HttpError(403, "Invalid origin");
  }
}

export async function createSession(
  idToken: string,
  inviteCode?: string,
): Promise<{ token: string; user: AppUser }> {
  const env = serverEnvironment();
  const body = new URLSearchParams({
    id_token: idToken,
    client_id: env.LINE_LOGIN_CHANNEL_ID,
  });
  const response = await fetch("https://api.line.me/oauth2/v2.1/verify", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    cache: "no-store",
  });
  if (!response.ok) throw new HttpError(401, "LINE login failed");
  const identity = z
    .object({ sub: z.string(), aud: z.string(), exp: z.number() })
    .parse(await response.json());
  if (
    identity.aud !== env.LINE_LOGIN_CHANNEL_ID ||
    identity.exp <= Math.floor(Date.now() / 1_000)
  ) {
    throw new HttpError(401, "LINE login expired");
  }
  const db = serverDatabase(env);
  const result = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("line_user_id", identity.sub)
    .maybeSingle();
  if (result.error) throw new Error("user lookup failed");
  let user = userSchema.nullable().parse(result.data);
    if (!user && inviteCode) {
    if (!safeSecretEqual(inviteCode.trim(), env.COUPLE_SETUP_CODE)) {
      throw new HttpError(403, "邀請連結無效");
    }
    const claimed = await claimUser(db, identity.sub);
    if (claimed.result === "full") {
      throw new HttpError(403, "帳本已綁定兩位使用者");
    }
    const refreshed = await db
      .from("users")
      .select("id, couple_id, line_user_id, role")
      .eq("line_user_id", identity.sub)
      .single();
    if (refreshed.error) throw new Error("user lookup failed");
    user = userSchema.parse(refreshed.data);
  }
  if (!user) throw new HttpError(403, "請先在 LINE Bot 輸入加入設定碼");
  const expiresAt = Math.min(
    identity.exp,
    Math.floor(Date.now() / 1_000) + SESSION_SECONDS,
  );
  return {
    token: signSession(
      { userId: user.id, lineUserId: user.line_user_id, expiresAt },
      env.LIFF_SESSION_SECRET,
    ),
    user,
  };
}

export async function requireContext(request: Request): Promise<ServerContext> {
  const env = serverEnvironment();
  const cookie = parseCookie(request.headers.get("cookie") ?? "").get(
    SESSION_COOKIE,
  );
  const session = cookie
    ? verifySession(cookie, env.LIFF_SESSION_SECRET)
    : null;
  if (!session) throw new HttpError(401, "Session expired");
  const db = serverDatabase(env);
  const result = await db
    .from("users")
    .select("id, couple_id, line_user_id, role")
    .eq("id", session.userId)
    .eq("line_user_id", session.lineUserId)
    .single();
  if (result.error) throw new HttpError(401, "User not found");
  return { env, db, user: userSchema.parse(result.data) };
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_SECONDS}`;
}

function parseCookie(value: string): Map<string, string> {
  return new Map(
    value
      .split(";")
      .map((part) => part.trim().split("=", 2) as [string, string]),
  );
}
