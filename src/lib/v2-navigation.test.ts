import test from "node:test";
import assert from "node:assert/strict";

import { v2SecondaryTabFromUrlValue } from "./v2-navigation";

test("V2 Rich Menu tab values open the matching Ledger sub-navigation", () => {
  assert.equal(v2SecondaryTabFromUrlValue("analysis"), "stats");
  assert.equal(v2SecondaryTabFromUrlValue("stats"), "stats");
  assert.equal(v2SecondaryTabFromUrlValue("settings"), "settings");
  assert.equal(v2SecondaryTabFromUrlValue("recurring"), "recurring");
  assert.equal(v2SecondaryTabFromUrlValue("dashboard"), "history");
  assert.equal(v2SecondaryTabFromUrlValue(null), "history");
});
