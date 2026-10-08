import { integerTwd } from "@/lib/format";

export type LedgerBalanceSummaryProps = {
  selfBalance: string | null;
  nextPayerLabel?: string | null;
  loading?: boolean;
  stale?: boolean;
  ledgerVersion?: number;
};

/** Canonical values only. No accounting, requests, or financial state ownership. */
export function LedgerBalanceSummary({ selfBalance, nextPayerLabel, loading = false, stale = false, ledgerVersion }: LedgerBalanceSummaryProps) {
  const balance = selfBalance !== null && /^-?\d+$/.test(selfBalance) ? BigInt(selfBalance) : null;
  const headline = balance === 0n ? "目前很平衡" : balance !== null && balance > 0n ? "你目前多付" : "另一半目前多付";

  return <section data-testid="ledger-balance" data-ledger-version={ledgerVersion}
    aria-label="帳本近況" aria-busy={loading || undefined} className="min-w-0 min-h-[6.5rem] space-y-1">
    {balance === null ? loading ? <div role="status" className="space-y-3 py-1">
      <p className="sr-only">正在載入近況…</p>
      <div aria-hidden="true" className="h-6 w-32 rounded bg-border" />
      <div aria-hidden="true" className="h-9 w-48 max-w-full rounded bg-border" />
      <div aria-hidden="true" className="h-4 w-56 max-w-full rounded bg-border" />
    </div> : <p className="text-[1.0625rem] leading-[1.5625rem]">暫時無法讀取近況</p> : <>
      <h2 className="text-[1.0625rem] leading-[1.5625rem] font-medium">{headline}</h2>
      {balance !== 0n ? <p className="text-[1.75rem] leading-9 font-semibold tabular-nums [overflow-wrap:anywhere]">
        <span className="sr-only">{headline} </span><span data-testid="ledger-balance-amount">{integerTwd(balance < 0n ? -balance : balance)}</span>
      </p> : null}
      {balance === 0n ? <p className="pt-1 text-[1.0625rem] leading-[1.5625rem] text-[var(--ink-2)]">下次誰方便，就由誰付款</p>
        : nextPayerLabel ? <p className="pt-1 text-[1.0625rem] leading-[1.5625rem] text-[var(--ink-2)] [overflow-wrap:anywhere]">下次建議由 {nextPayerLabel} 付款</p> : null}
      {stale ? <p role="status" className="pt-1 text-sm text-[var(--ink-2)]">尚未更新</p> : null}
    </>}
  </section>;
}
