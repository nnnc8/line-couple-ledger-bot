import test from "node:test";
import assert from "node:assert/strict";

import { v2SecondaryTabFromUrlValue } from "./v2-navigation";

test("V2 Rich Menu tab values open the matching Ledger sub-navigation", () => {
  assert.equal(v2SecondaryTabFromUrlValue("analysis"), "stats");
  assert.equal(v2SecondaryTabFromUrlValue("stats"), "stats");
  assert.equal(v2SecondaryTabFromUrlValue("settings"), "settings");
  assert.equal(v2SecondaryTabFromUrlValue("recurring"), "settings");
  assert.equal(v2SecondaryTabFromUrlValue("dashboard"), "history");
  assert.equal(v2SecondaryTabFromUrlValue(null), "history");
});

import { appOrigin, ledgerHome, navigationHistoryMode, navigationHistoryState, navigationParams, navigationUrl, parseNavigation, resolveLedgerTarget } from "./v2-navigation";
const ledgers = [{ id: "A", status: "active", activeForUser: true }, { id: "B", status: "active" }, { id: "archived", status: "archived" }];

test("explicit Home accepts only active authorized scope; fallback requires absent target", () => {
  assert.equal(parseNavigation("?v2Ledger=B").surface, "HOME");
  assert.deepEqual(resolveLedgerTarget(parseNavigation("?v2Ledger=B"), ledgers), { ledgerId: "B", error: null });
  for (const id of ["unknown", "unauthorized", "archived", ""]) {
    const nav = parseNavigation(`?v2Ledger=${id}`);
    assert.equal(nav.explicitLedger, true);
    assert.equal(nav.ledgerId, id);
    assert.deepEqual(resolveLedgerTarget(nav, ledgers), { ledgerId: null, error: "ledger" });
  }
  assert.deepEqual(resolveLedgerTarget(parseNavigation(""), ledgers), { ledgerId: "A", error: null });
});

test("transaction scope is mandatory, never guessed from active Ledger", () => {
  const nav = parseNavigation("?v2Ledger=B&v2Transaction=T");
  assert.equal(nav.surface, "TRANSACTION_DETAIL");
  assert.equal(nav.transactionId, "T");
  assert.equal(navigationUrl(nav), "/?v2Ledger=B&v2Transaction=T");
  assert.deepEqual(resolveLedgerTarget(parseNavigation("?v2Transaction=T"), ledgers), { ledgerId: null, error: "transaction-scope" });
});

for (const [query, surface] of [["tab=stats", "STATS"], ["tab=analysis", "STATS"], ["tab=settings", "SETTINGS"], ["tab=recurring", "RECURRING"], ["view=search&q=food&type=expense&from=2026-09-01", "SEARCH"], ["v2Proposal=P&v2Transaction=T", "PROPOSAL_COMPAT_ENTRY"]]) {
  test(`bounded surface mapping: ${surface} ${query}`, () => {
    const nav = parseNavigation(`?v2Ledger=B&${query}`);
    assert.equal(nav.surface, surface);
    assert.equal(parseNavigation(navigationUrl(nav).split("?")[1]!).surface, surface);
    if (surface === "SEARCH") assert.deepEqual(nav.filters, { q: "food", type: "expense", from: "2026-09-01" });
  });
}

test("LIFF envelope is read without mutation and direct params take priority", () => {
  const search = "?liff.state=%3Fv2Ledger%3DB%26tab%3Dstats&v2Ledger=A&liff.referrer=line";
  assert.equal(parseNavigation(search).ledgerId, "A");
  assert.equal(parseNavigation(search).surface, "STATS");
  assert.equal(navigationParams(search).get("liff.referrer"), "line");
  assert.equal(navigationUrl(ledgerHome("B"), `/${search}#anchor`), "/?liff.referrer=line&v2Ledger=B#anchor");
});

test("canonical Home removes old surface/search but preserves unrelated query/hash", () => {
  assert.equal(navigationUrl(ledgerHome("B"), "/?v2Ledger=A&v2Transaction=T&tab=stats&view=search&q=private&unknown=value#anchor"), "/?unknown=value&v2Ledger=B#anchor");
});

test("only read-surface entry pushes; initialization/switch/filter/direct Back replace", () => {
  assert.equal(navigationHistoryMode("open"), "push");
  for (const reason of ["initialize", "switch", "back", "filter"] as const) assert.equal(navigationHistoryMode(reason), "replace");
});

test("origin is bounded, preserves Next/unrelated state, and expires on reload", () => {
  const next = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["tree"], unrelated: { retained: true } };
  const origin = { version: 1 as const, documentId: "document-1", ledgerId: "A", rowId: "T", draft: "secret", api: { financial: true }, recovery: "key" };
  const state = navigationHistoryState(next, origin);
  assert.deepEqual(state, { ...next, v2LedgerOrigin: { version: 1, documentId: "document-1", ledgerId: "A", rowId: "T" } });
  assert.equal(JSON.stringify(state).includes("secret"), false);
  assert.equal(appOrigin(state, "document-1", "A")?.rowId, "T");
  assert.equal(appOrigin(state, "document-2", "A"), null);
  assert.equal(appOrigin(state, "document-1", "B"), null);
  assert.equal(appOrigin(null, "document-1", "A"), null);
  assert.deepEqual(navigationHistoryState(state, null), { ...next, v2LedgerOrigin: null });
});
