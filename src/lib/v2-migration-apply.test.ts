import assert from "node:assert/strict";
import test from "node:test";

import { buildV2MigrationPlan } from "./v2-migration";

test("migration cutover gate rejects a non-reconciled plan before any write", () => {
  const plan = buildV2MigrationPlan({
    coupleId: 1,
    users: [
      { id: "00000000-0000-0000-0000-000000000001", couple_id: 1, role: "owner" },
      { id: "00000000-0000-0000-0000-000000000002", couple_id: 1, role: "partner" },
    ],
    groups: [{
      id: "10000000-0000-0000-0000-000000000001",
      couple_id: 1,
      name: "共同生活",
      color: "#173B63",
      created_by_user_id: "00000000-0000-0000-0000-000000000001",
      archived_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    }],
    expenses: [],
    settlements: [],
  });
  assert.equal(plan.quarantine.length, 0);
  assert.equal(plan.summaries[0]?.oldBalance["00000000-0000-0000-0000-000000000001"], 0n);
  assert.equal(plan.summaries[0]?.v2Balance["00000000-0000-0000-0000-000000000001"], 0n);
});
