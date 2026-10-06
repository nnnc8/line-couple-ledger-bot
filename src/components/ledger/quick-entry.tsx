"use client";

import { V2TransactionEditor, type EntryControlSurface } from "./v2-transaction-editor";
import { EntryStatus } from "./entry-status";
import type { V2EntrySession } from "@/hooks/use-v2-entry-session";
import type { User, V2Category, V2LedgerBootstrap } from "@/lib/types";

/** A view onto P1-B's root session; this surface never dispatches an API. */
export function QuickEntry({ entry, bootstrap, user, partner, categories, onCancel, onOpenControls }: {
  entry: V2EntrySession; bootstrap: V2LedgerBootstrap; user: User; partner: User;
  categories: readonly V2Category[];
  onCancel: () => void;
  onOpenControls: (surface: EntryControlSurface, trigger: HTMLElement) => void;
}) {
  const draft = entry.draft;
  return <div data-entry data-testid="quick-entry" className="min-w-0 pb-[max(16px,env(safe-area-inset-bottom))]">
    <p id="quick-entry-ledger" className="mb-4 break-words font-semibold [overflow-wrap:anywhere]" data-testid="quick-entry-ledger">{bootstrap.ledger.name}</p>
    {draft?.ledgerId === bootstrap.ledger.id ? <V2TransactionEditor key={draft.id}
      user={user} partner={partner} draft={draft}
      categoryOptions={categories.filter(category => category.ledgerId === draft.ledgerId && category.status === "active").map(category => ({ id: category.id, name: category.name }))}
      busy={entry.write === "submitting"} locked={entry.locked}
      errorField={entry.field} serverError={entry.error}
      scopeValid={Boolean(bootstrap.ledger.members.length === draft.memberIds.length && bootstrap.ledger.status === "active" && draft.actorUserId === user.id && draft.coupleId === bootstrap.ledger.coupleId && draft.memberIds.every((id, index) => id === bootstrap.ledger.members[index]?.userId))}
      onChange={entry.updateDraft} onSubmit={entry.submit} onCancel={onCancel} onOpenControls={onOpenControls} /> : null}
    <EntryStatus entry={entry} ledgerId={bootstrap.ledger.id} />
  </div>;
}
