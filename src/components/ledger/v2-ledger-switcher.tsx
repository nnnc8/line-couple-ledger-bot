"use client";

import { useId, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { V2LedgerSummary } from "@/lib/types";

/** Presentation only: every choice goes through the root's P1-C leave intent. */
export function V2LedgerSwitcher({ ledgers, activeLedgerId, selectedLedgerId, onChange, onCreate, choosingDestination = false }: {
  ledgers: V2LedgerSummary[];
  activeLedgerId: string | null;
  selectedLedgerId: string | null;
  onChange: (ledgerId: string) => void;
  onCreate: () => void;
  choosingDestination?: boolean;
}) {
  const id = useId();
  const active = ledgers.filter(ledger => ledger.status === "active");
  const defaultId = active.find(ledger => ledger.activeForUser)?.id;
  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    const index = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
      : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    event.preventDefault();
    options[next]?.focus();
  }
  return <div className="space-y-3">
    {active.length ? <div role="listbox" aria-label="帳本" onKeyDown={moveFocus} className="space-y-1">
      {active.map((ledger, index) => {
        const selected = ledger.id === selectedLedgerId;
        const viewed = ledger.id === activeLedgerId;
        const lineDefault = ledger.id === defaultId && defaultId !== activeLedgerId;
        return <button key={ledger.id} type="button" role="option" aria-selected={selected}
          aria-labelledby={`${id}-name-${index}`} aria-describedby={viewed || lineDefault ? `${id}-status-${index}` : undefined}
          tabIndex={selected || !selectedLedgerId && index === 0 ? 0 : -1}
          data-ledger-option={ledger.id} onClick={() => onChange(ledger.id)}
          className="flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted aria-selected:bg-muted">
          <span className="min-w-0 flex-1">
            <span id={`${id}-name-${index}`} className="block font-semibold [overflow-wrap:anywhere]">{ledger.name}</span>
            {viewed || lineDefault ? <span id={`${id}-status-${index}`} className="block text-sm text-[var(--muted-foreground)]">{viewed ? "目前查看" : "LINE 記帳預設"}</span> : null}
          </span>
          {selected ? <Check aria-hidden="true" className="size-5 shrink-0" /> : null}
        </button>;
      })}
    </div> : <p>還沒有帳本。</p>}
    {!choosingDestination ? <div className="border-t border-[var(--border)] pt-3">
      <Button tabIndex={0} variant="ghost" size="block" className="h-auto min-h-11 justify-start whitespace-normal text-left" onClick={onCreate}>建立帳本</Button>
    </div> : null}
  </div>;
}
