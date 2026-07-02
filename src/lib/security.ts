import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppSession {
  userId: string;
  lineUserId: string;
  expiresAt: number;
}

export function safeSecretEqual(received: string, expected: string): boolean {
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return (
    receivedBuffer.length === expectedBuffer.length &&
    timingSafeEqual(receivedBuffer, expectedBuffer)
  );
}

export function signSession(session: AppSession, secret: string): string {
  if (secret.length < 32)
    throw new Error("LIFF_SESSION_SECRET must be at least 32 characters");
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySession(
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1_000),
): AppSession | null {
  const [payload, received, extra] = token.split(".");
  if (!payload || !received || extra || secret.length < 32) return null;
  const expected = signature(payload, secret);
  const left = Buffer.from(received);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right))
    return null;
  try {
    const value = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as Partial<AppSession>;
    if (
      typeof value.userId !== "string" ||
      typeof value.lineUserId !== "string" ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt < now
    )
      return null;
    return value as AppSession;
  } catch {
    return null;
  }
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
