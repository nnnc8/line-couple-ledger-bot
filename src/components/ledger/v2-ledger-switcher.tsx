"use client";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { V2LedgerSummary } from "@/lib/types";

/** The existing select lives inside the root's one native dialog host. */
export function V2LedgerSwitcher({ ledgers, activeLedgerId, selectedLedgerId, onChange, onCreate, choosingDestination = false }: {
  ledgers: V2LedgerSummary[];
  activeLedgerId: string | null;
  selectedLedgerId: string | null;
  onChange: (ledgerId: string) => void;
  onCreate: () => void;
  choosingDestination?: boolean;
}) {
  const active = ledgers.filter(ledger => ledger.status === "active");
  return <div className="space-y-3">
    {active.length ? <Select ariaLabel="切換帳本" value={selectedLedgerId ?? ""} onValueChange={onChange}
      options={active.map(ledger => ({ value: ledger.id, label: `${ledger.name}${ledger.id === activeLedgerId ? " · 目前查看" : ""}${ledger.activeForUser ? " · LINE 記帳預設" : ""}` }))} /> : <p>尚無帳本。</p>}
    {!choosingDestination ? <div className="flex flex-wrap gap-2">
      {activeLedgerId ? <Button variant="outline" size="sm" onClick={() => onChange(activeLedgerId)}>設為 LINE 記帳預設</Button> : null}
      <Button variant="ghost" size="sm" onClick={onCreate}>建立帳本</Button>
    </div> : null}
  </div>;
}
