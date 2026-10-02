export type V2SecondaryTab = "history" | "stats" | "settings";

export type V2Surface = "HOME" | "TRANSACTION_DETAIL" | "STATS" | "SETTINGS" | "RECURRING" | "SEARCH" | "PROPOSAL_COMPAT_ENTRY";
export const searchKeys = ["q", "type", "payerUserId", "categoryId", "from", "to"] as const;
export type SearchFilters = Partial<Record<typeof searchKeys[number], string>>;
export type V2Navigation = {
  surface: V2Surface;
  ledgerId: string | null;
  explicitLedger: boolean;
  transactionId: string | null;
  proposalId: string | null;
  filters: SearchFilters;
};
export type AppOrigin = { version: 1; documentId: string; ledgerId: string; rowId?: string };
export const originKey = "v2LedgerOrigin";

/** Read LIFF's initial redirect envelope without changing it before liff.init. */
export function navigationParams(search: string): URLSearchParams {
  const direct = new URLSearchParams(search);
  const state = direct.get("liff.state");
  if (state) {
    const nested = new URLSearchParams(state.includes("?") ? state.slice(state.indexOf("?") + 1) : state);
    nested.forEach((value, key) => { if (!direct.has(key)) direct.set(key, value); });
  }
  return direct;
}

export function parseNavigation(search: string): V2Navigation {
  const params = navigationParams(search);
  const proposalId = params.get("v2Proposal");
  const transactionId = params.get("v2Transaction");
  const tab = params.get("tab");
  return {
    surface: proposalId ? "PROPOSAL_COMPAT_ENTRY" : transactionId ? "TRANSACTION_DETAIL"
      : params.get("view") === "search" ? "SEARCH" : tab === "stats" || tab === "analysis" ? "STATS"
        : tab === "recurring" ? "RECURRING" : tab === "settings" ? "SETTINGS" : "HOME",
    ledgerId: params.get("v2Ledger"), explicitLedger: params.has("v2Ledger"), transactionId, proposalId,
    filters: Object.fromEntries(searchKeys.flatMap(key => params.has(key) ? [[key, params.get(key)!]] : [])),
  };
}

export function ledgerHome(ledgerId: string | null): V2Navigation {
  return { surface: "HOME", ledgerId, explicitLedger: ledgerId !== null, transactionId: null, proposalId: null, filters: {} };
}

export function resolveLedgerTarget(nav: V2Navigation, ledgers: Array<{ id: string; status: string; activeForUser?: boolean }>): { ledgerId: string | null; error: "ledger" | "transaction-scope" | null } {
  if (nav.surface === "TRANSACTION_DETAIL" && !nav.ledgerId) return { ledgerId: null, error: "transaction-scope" };
  const active = ledgers.filter(ledger => ledger.status === "active");
  if (nav.explicitLedger) return active.some(ledger => ledger.id === nav.ledgerId)
    ? { ledgerId: nav.ledgerId, error: null } : { ledgerId: null, error: "ledger" };
  return { ledgerId: active.find(ledger => ledger.activeForUser)?.id ?? active[0]?.id ?? null, error: null };
}

/** Called only after LIFF initialization. Preserve unrelated query/hash values. */
export function navigationUrl(nav: V2Navigation, current = "/"): string {
  const url = new URL(current, "https://ledger.invalid");
  for (const key of ["v2Ledger", "v2Transaction", "v2Proposal", "tab", "view", "liff.state", ...searchKeys]) url.searchParams.delete(key);
  if (nav.ledgerId !== null) url.searchParams.set("v2Ledger", nav.ledgerId);
  if (nav.surface === "TRANSACTION_DETAIL" && nav.transactionId) url.searchParams.set("v2Transaction", nav.transactionId);
  if (nav.surface === "PROPOSAL_COMPAT_ENTRY" && nav.proposalId) url.searchParams.set("v2Proposal", nav.proposalId);
  if (["STATS", "SETTINGS", "RECURRING"].includes(nav.surface)) url.searchParams.set("tab", nav.surface.toLowerCase());
  if (nav.surface === "SEARCH") {
    url.searchParams.set("view", "search");
    for (const key of searchKeys) if (nav.filters[key]) url.searchParams.set(key, nav.filters[key]!);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function navigationHistoryMode(reason: "open" | "initialize" | "switch" | "back" | "filter"): "push" | "replace" {
  return reason === "open" ? "push" : "replace";
}

export function navigationHistoryState(previous: unknown, origin: AppOrigin | null): Record<string, unknown> {
  const state = previous && typeof previous === "object" ? { ...previous } : {};
  // Explicit allowlist: never serialize a draft, API result or recovery operation.
  return { ...state, [originKey]: origin ? { version: 1, documentId: origin.documentId, ledgerId: origin.ledgerId, ...(origin.rowId ? { rowId: origin.rowId } : {}) } : null };
}

export function appOrigin(state: unknown, documentId: string, ledgerId: string | null): AppOrigin | null {
  const origin = state && typeof state === "object" ? (state as Record<string, unknown>)[originKey] as AppOrigin | undefined : undefined;
  return origin?.version === 1 && origin.documentId === documentId && origin.ledgerId === ledgerId ? origin : null;
}

/** Map public LIFF/Rich Menu tab values to the V2 Ledger sub-navigation. */
export function v2SecondaryTabFromUrlValue(value: string | null | undefined): V2SecondaryTab {
  switch (value) {
    case "analysis":
    case "stats":
      return "stats";
    case "recurring":
      return "settings";
    case "settings":
      return "settings";
    default:
      return "history";
  }
}
