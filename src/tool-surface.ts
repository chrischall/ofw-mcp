import { getExpenseOnly } from './config.js';

export interface ToolSurfaceRegistrars<T> {
  healthcheck: T;
  user: T;
  messages: T;
  calendar: T;
  expenses: T;
  journal: T;
}

/**
 * Select the registrars exposed by this deployment.
 *
 * Expense-only mode is structural: omitted registrars are never handed to
 * runMcp, so their tools cannot appear in tools/list or be invoked by name.
 * OFW_EXPENSE_UPLOAD_ONLY implies this same registrar restriction and the
 * expense registrar itself removes its read tools.
 */
export function selectToolRegistrars<T>(r: ToolSurfaceRegistrars<T>): T[] {
  if (getExpenseOnly()) return [r.healthcheck, r.expenses];
  return [r.healthcheck, r.user, r.messages, r.calendar, r.expenses, r.journal];
}
