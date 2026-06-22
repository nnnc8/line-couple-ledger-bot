import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppSession {
  userId: string;
  lineUserId: string;
  expiresAt: number;
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

export function detectReceiptMime(bytes: Uint8Array): string | null {
  const buffer = Buffer.from(bytes);
  if (buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])))
    return "image/jpeg";
  if (
    buffer
      .subarray(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  )
    return "image/png";
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  const brand = buffer.subarray(8, 12).toString();
  if (
    buffer.subarray(4, 8).toString() === "ftyp" &&
    ["heic", "heix", "heif", "hevc", "mif1"].includes(brand)
  ) {
    return brand === "heif" || brand === "mif1" ? "image/heif" : "image/heic";
  }
  return null;
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
