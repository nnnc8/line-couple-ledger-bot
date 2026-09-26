import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

function compare({ line = 10, expression = "loadStatistics()", count = 1, ruleId = "react-hooks/set-state-in-effect" } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "lint-delta-"));
  const filePath = path.join(root, "fixture.tsx");
  writeFileSync(filePath, "fixture");
  const message = (position, source) => `Existing diagnostic\n\n${filePath}:${position}:10\n> ${position} | ${source}\n    | ^ existing reason`;
  const finding = (text, rule) => ({ ruleId: rule, severity: 2, message: text });
  const report = messages => [{ filePath, errorCount: messages.length, warningCount: 0, messages }];
  const base = path.join(root, "base.json"), head = path.join(root, "head.json");
  writeFileSync(base, JSON.stringify(report([finding(message(10, "loadStatistics()"), "react-hooks/set-state-in-effect")])));
  writeFileSync(head, JSON.stringify(report(Array.from({ length: count }, () => finding(message(line, expression), ruleId)))));
  try { return spawnSync(process.execPath, [".github/scripts/check-lint-baseline.mjs", base, head, root, root], { encoding: "utf8" }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("lint baseline permits unchanged findings moved to other lines", () => assert.equal(compare({ line: 208 }).status, 0));
test("lint baseline still rejects a different offending expression", () => assert.equal(compare({ expression: "newUnsafeWrite()" }).status, 1));
test("lint baseline still rejects additional occurrences", () => assert.equal(compare({ count: 2 }).status, 1));
test("lint baseline still rejects a new rule", () => assert.equal(compare({ ruleId: "new-rule" }).status, 1));
test("lint baseline permits removed findings", () => assert.equal(compare({ count: 0 }).status, 0));
