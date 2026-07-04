/**
 * accountant-agent — AI agent flow + category cleanup.
 *
 * Thin barrel module exporting public schemas, types, and logic functions
 * from submodules.
 */

export {
  accountantAskInputSchema,
  agentRunInputSchema,
  categoryAnalyticsInputSchema,
  categoryCleanupInputSchema,
  type CleanupActionInput,
} from "./accountant-agent-contracts";

export { ask, runAgent } from "./accountant-agent-runner";

export {
  categoryAnalytics,
  suggestCategoryUpdates,
  createCategoryCleanup,
} from "./accountant-category-cleanup";

export type {
  AccountantScope,
  AccountantReportType,
} from "./accountant";
