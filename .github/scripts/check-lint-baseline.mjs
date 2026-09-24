import fs from "node:fs";
import path from "node:path";

const [baselinePath, currentPath, baselineRoot, currentRoot] = process.argv.slice(2);
if (!baselinePath || !currentPath || !baselineRoot || !currentRoot) {
  throw new Error("Usage: check-lint-baseline.mjs <baseline-json> <current-json> <baseline-root> <current-root>");
}

function readReport(reportPath, root) {
  const files = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const resolvedRoot = fs.realpathSync(root);
  const counts = new Map();
  const totals = { errors: 0, warnings: 0 };

  for (const file of files) {
    const relativePath = path.relative(resolvedRoot, fs.realpathSync(file.filePath)).split(path.sep).join("/");
    totals.errors += file.errorCount;
    totals.warnings += file.warningCount;
    for (const message of file.messages) {
      const normalizedMessage = message.message.split(resolvedRoot).join("<project>");
      const signature = JSON.stringify([
        relativePath,
        message.ruleId ?? "<fatal>",
        message.severity,
        message.messageId ?? "",
        normalizedMessage,
      ]);
      counts.set(signature, (counts.get(signature) ?? 0) + 1);
    }
  }

  return { counts, totals };
}

const baseline = readReport(baselinePath, baselineRoot);
const current = readReport(currentPath, currentRoot);
const additions = [];

for (const [signature, count] of current.counts) {
  const increase = count - (baseline.counts.get(signature) ?? 0);
  if (increase > 0) additions.push({ finding: JSON.parse(signature), count: increase });
}

console.log(`ESLint baseline: ${baseline.totals.errors} errors, ${baseline.totals.warnings} warnings.`);
console.log(`Current branch: ${current.totals.errors} errors, ${current.totals.warnings} warnings.`);

if (additions.length) {
  console.error("New lint findings relative to the base branch:");
  for (const { finding, count } of additions) {
    console.error(`+${count} ${finding[0]} [${finding[1]}] ${finding[4]}`);
  }
  process.exitCode = 1;
} else {
  console.log("No new lint findings relative to the base branch.");
}
