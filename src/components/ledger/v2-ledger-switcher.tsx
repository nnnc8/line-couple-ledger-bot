"use client";

import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import type { V2LedgerSummary } from "@/lib/types";

export function V2LedgerSwitcher({
  ledgers,
  activeLedgerId,
  onChange,
  onCreate,
}: {
  ledgers: V2LedgerSummary[];
  activeLedgerId: string | null;
  onChange: (ledgerId: string) => void;
  onCreate: () => void;
}) {
  const active = ledgers.filter((ledger) => ledger.status === "active");
  if (!active.length) {
    return (
      <Button variant="outline" size="sm" className="h-11" onClick={onCreate}>
        <Plus className="size-4" /> 建立 Ledger
      </Button>
    );
  }
  return (
    <label className="flex min-w-0 items-center gap-2">
      <span className="text-[13px] font-medium text-[var(--muted-foreground)]">Ledger</span>
      <Select
        ariaLabel="切換 Ledger"
        value={activeLedgerId ?? active[0]!.id}
        onValueChange={onChange}
        className="max-w-[180px] truncate"
        options={active.map((ledger) => ({ value: ledger.id, label: ledger.name }))}
      />
      <Button variant="ghost" size="sm" className="h-11 px-2" aria-label="建立 Ledger" onClick={onCreate}>
        <Plus className="size-4" />
      </Button>
    </label>
  );
}
