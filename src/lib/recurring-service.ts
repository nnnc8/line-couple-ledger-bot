import { LedgerCommandService } from "./ledger-core";
import { recurringSaveHandler } from "./recurring-save";
import { recurringRunnerHandler } from "./recurring-runner";
import type { RecurringSaveContext, RecurringRunContext } from "./recurring-types";

export class RecurringService {
  readonly ledgerCommandService: LedgerCommandService;

  constructor(input?: { ledgerCommandService?: LedgerCommandService }) {
    this.ledgerCommandService =
      input?.ledgerCommandService ?? new LedgerCommandService();
  }

  async save(
    context: RecurringSaveContext,
    input: unknown,
  ): Promise<{ ok: true }> {
    return recurringSaveHandler.saveRecurring(this, context, input);
  }

  async runDue<Env>(
    context: RecurringRunContext<Env>,
  ): Promise<number> {
    return recurringRunnerHandler.runDueRecurring(context);
  }
}
