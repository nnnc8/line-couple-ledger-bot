const LIFF_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;

export function requireLiffId(
  env: Record<string, string | undefined> = process.env,
): string {
  const liffId = env.NEXT_PUBLIC_LIFF_ID?.trim();
  if (!liffId) throw new Error("NEXT_PUBLIC_LIFF_ID is required");
  if (!LIFF_ID_PATTERN.test(liffId)) {
    throw new Error("NEXT_PUBLIC_LIFF_ID is invalid");
  }
  return liffId;
}

export function buildLiffUrl(
  liffId: string,
  values: Record<string, string | undefined> = {},
): string {
  if (!LIFF_ID_PATTERN.test(liffId)) {
    throw new Error("NEXT_PUBLIC_LIFF_ID is invalid");
  }
  const url = new URL(`https://liff.line.me/${liffId}/`);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}
