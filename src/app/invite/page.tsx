import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type InvitePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function InvitePage({ searchParams }: InvitePageProps) {
  const params = await searchParams;
  const code = first(params.code).trim();
  const liffId = process.env.NEXT_PUBLIC_LIFF_ID;
  const lineBasicId = process.env.NEXT_PUBLIC_LINE_BASIC_ID ?? "@675jxicy";

  const liffUrl = liffId ? new URL(`https://liff.line.me/${liffId}`) : null;
  if (liffUrl && code) liffUrl.searchParams.set("invite", code);

  const addFriendUrl = `https://line.me/R/ti/p/${encodeURIComponent(lineBasicId)}`;
  const messageUrl = `https://line.me/R/oaMessage/${encodeURIComponent(
    lineBasicId,
  )}/?${encodeURIComponent(`加入 ${code}`)}`;

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-6 py-10">
      <Card className="w-full max-w-md p-6">
        <div className="mx-auto mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary text-2xl font-extrabold text-primary-foreground shadow-[var(--shadow-fab)]">
          共
        </div>
        <p className="text-center text-[11px] font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">
          邀請加入
        </p>
        <h1 className="mt-1 text-center text-xl font-bold tracking-tight">
          共同帳本
        </h1>

        {code && liffUrl ? (
          <>
            <p className="mt-4 text-[14px] leading-relaxed text-[var(--ink-2)]">
              先加入官方帳號，再開帳本。LINE 不允許網頁自動替你加好友，所以第一步要手動點一次。
            </p>

            <div className="mt-5 space-y-3">
              <Button variant="primary" size="block" className="font-bold">
                <a href={addFriendUrl} className="flex w-full items-center justify-center gap-2 no-underline text-primary-foreground">
                  1. 加入官方帳號
                </a>
              </Button>
              <Button variant="outline" size="block">
                <a href={liffUrl.toString()} className="flex w-full items-center justify-center gap-2 no-underline">
                  2. 開啟帳本並加入
                </a>
              </Button>
              <a
                href={messageUrl}
                className="block pt-1 text-center text-[13px] font-medium text-accent hover:underline"
              >
                備用：開官方帳號並帶入「加入」訊息
              </a>
            </div>

            <p className="mt-5 text-[13px] leading-relaxed text-[var(--muted-foreground)]">
              如果第二步沒有自動加入，請在官方帳號聊天室送出：
              <br />
              <code className="mt-1 inline-block rounded-md bg-muted px-2 py-1 text-[12px] text-foreground">
                加入 {code}
              </code>
            </p>
          </>
        ) : (
          <p className="mt-4 text-[14px] text-[var(--muted-foreground)]">
            這個邀請連結缺少邀請碼，請重新跟對方拿連結。
          </p>
        )}
      </Card>
    </main>
  );
}