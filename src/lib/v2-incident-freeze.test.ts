import assert from "node:assert/strict";
import test from "node:test";

import {
  V2_FINANCIAL_MAINTENANCE_MESSAGE,
  V2IncidentFreezeError,
  isV2IncidentBootstrapOnly,
  isV2IncidentBootstrapDelete,
  isV2IncidentBootstrapRead,
  isV2IncidentBootstrapWrite,
  isV2IncidentFreezeError,
} from "./v2-incident-freeze";

test("incident freeze error has the stable maintenance response", () => {
  const error = new V2IncidentFreezeError();
  assert.equal(error.status, 503);
  assert.equal(error.message, V2_FINANCIAL_MAINTENANCE_MESSAGE);
  assert.equal(isV2IncidentFreezeError(error), true);
});

test("incident freeze detection does not classify ordinary errors", () => {
  assert.equal(isV2IncidentFreezeError(new Error("other")), false);
});

test("bootstrap-only mode is explicit and disabled by default", () => {
  assert.equal(isV2IncidentBootstrapOnly({}), false);
  assert.equal(isV2IncidentBootstrapOnly({ V2_INCIDENT_BOOTSTRAP_ONLY: "0" }), false);
  assert.equal(isV2IncidentBootstrapOnly({ V2_INCIDENT_BOOTSTRAP_ONLY: "1" }), true);
});

test("bootstrap-only mode allows only schema-compatible V2 reads", () => {
  assert.equal(isV2IncidentBootstrapRead(["v2", "context"]), true);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers"]), true);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers", "ledger-id", "bootstrap"]), true);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers", "ledger-id", "transactions"]), true);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers", "ledger-id", "statistics"]), false);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers", "ledger-id", "recurring"]), false);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers", "ledger-id", "categories"]), false);
  assert.equal(isV2IncidentBootstrapRead(["v2", "ledgers", "ledger-id", "transactions", "mutate"]), false);
  assert.equal(isV2IncidentBootstrapWrite(["v2", "ledgers", "ledger-id", "transactions"]), true);
  assert.equal(isV2IncidentBootstrapWrite(["v2", "transactions", "transaction-id", "mutate"]), true);
  assert.equal(isV2IncidentBootstrapWrite(["v2", "ledgers", "ledger-id", "categories"]), false);
  assert.equal(isV2IncidentBootstrapDelete(["v2", "attachments", "attachment-id"]), true);
});
