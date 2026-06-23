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
    <main className="invite-shell">
      <section className="invite-card">
        <div className="brand-mark">共</div>
        <span className="eyebrow">邀請加入</span>
        <h1>共同帳本</h1>
        {code && liffUrl ? (
          <>
            <p className="invite-copy">
              先加入官方帳號，再開帳本。LINE 不允許網頁自動替你加好友，所以第一步要手動點一次。
            </p>
            <div className="invite-steps">
              <a className="button-link primary-link" href={addFriendUrl}>
                1. 加入官方帳號
              </a>
              <a className="button-link" href={liffUrl.toString()}>
                2. 開啟帳本並加入
              </a>
              <a className="text-link" href={messageUrl}>
                備用：開官方帳號並帶入「加入」訊息
              </a>
            </div>
            <p className="invite-note">
              如果第二步沒有自動加入，請在官方帳號聊天室送出：
              <br />
              <code>加入 {code}</code>
            </p>
          </>
        ) : (
          <p className="invite-copy">這個邀請連結缺少邀請碼，請重新跟對方拿連結。</p>
        )}
      </section>
    </main>
  );
}
