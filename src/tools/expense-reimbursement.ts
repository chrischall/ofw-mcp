import type { McpServer } from '@modelcontextprotocol/server';
import { parseLenient } from '@chrischall/mcp-utils';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite, stateRevision } from './_confirm.js';
import { jsonErrorResponse, jsonResponse, requestWrite, UnconfirmedWriteError, unconfirmedWriteResponse } from './_shared.js';

// Allow ordinary binary floating point representations of exact cents, but
// never round a genuinely fractional cent or accept an unsafe monetary value.
const money = z.number().nonnegative().refine((v) => Number.isSafeInteger(Math.round(v * 100))
  && v === Math.round(v * 100) / 100, 'Must be an exact, safe cent amount');
const id = z.number().int().positive();
const detailSchema = z.looseObject({
  id, title: z.string().min(1).refine((v) => v.trim().length > 0), author: z.looseObject({ userId: id }),
  payer: z.looseObject({ userId: id }), private: z.boolean(), paymentType: z.string(),
  amount: z.looseObject({ total: money.refine((v) => v > 0), totalOwed: money, leftToPay: money }),
  status: z.string().min(1), statusInfo: z.looseObject({ baseStatus: z.string(), subStatus: z.literal('NONE') }),
  category: z.looseObject({ id, split: z.looseObject({ parentSplit: z.string(), coparentSplit: z.string() }) }),
  children: z.array(z.looseObject({ userId: id })).min(1),
}).refine((d) => d.amount.leftToPay <= d.amount.totalOwed && d.amount.totalOwed <= d.amount.total,
  'Inconsistent expense balances');
type Detail = z.infer<typeof detailSchema>;

// All fields outside the expected status/balance transition stay protected.
// OFW's amount display fields describe the current balance and legitimately
// change with settlement; the numeric purchase/owed totals remain immutable.
// Unknown fields outside these known derived displays remain protected too.
function immutableRevision(d: Detail): string {
  const { status: _status, statusInfo: _info, paymentType: _type, amount, ...rest } = d;
  const { leftToPay: _balance, leftToPayFmt: _balanceFmt, description: _description,
    color: _color, ...amountRest } = amount;
  return stateRevision({ ...rest, amount: amountRest });
}

/** Registered only by the full expense surface in write mode all. */
export function registerExpenseReimbursementTool(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_mark_expense_reimbursed', {
    description: 'Irreversibly mark the FULL remaining expense balance reimbursed externally. Records an already completed outside-OFW reimbursement only: does NOT send money or use bank/payment endpoints; no partial amounts. Requires expectedRemainingAmount (currency units, positive exact cents) matching the current leftToPay, NOT the full expense total. Reads the current expense, binds the entire detail to confirmation, rechecks immediately before writing, then verifies paid status and unchanged fields. Cannot be undone. On EXPENSE_REIMBURSEMENT_UNCONFIRMED, mayHaveLanded=true: inspect the OFW Expenses log before any retry; never replay blindly. ' + CONFIRM_NOTE,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      expenseId: id.describe('Existing expense entity id'),
      expectedRemainingAmount: money.refine((v) => v > 0, 'Must be positive').describe('Full remaining external reimbursement in currency units (e.g. 48.50); must match leftToPay, not the expense total'),
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const path = `/pub/v2/expense/expenses/${args.expenseId}`;
    const read = async (): Promise<Detail> => {
      const d = parseLenient(detailSchema, await client.request('GET', path),
        { label: 'ofw-mcp', context: `GET ${path} (mark reimbursed)`, mode: 'strict' });
      if (d.id !== args.expenseId) throw new Error('Expense id does not match the requested expense');
      return d;
    };
    let current: Detail;
    try { current = await read(); }
    catch {
      return jsonErrorResponse({ result: 'EXPENSE_REIMBURSEMENT_REFUSED', expenseId: args.expenseId,
        reason: 'Could not safely read the expense identity, status, parties and balances. Nothing was sent.' });
    }
    const base = current.statusInfo.baseStatus;
    if (base === 'PAID' && current.amount.leftToPay === 0) {
      return jsonResponse({ result: 'ALREADY_PAID', expenseId: args.expenseId, changed: false,
        note: 'OFW already reports paid with zero remaining balance. No write or money transfer was performed.' });
    }
    if (!['OPEN', 'APPROVED', 'PARTIAL'].includes(base) || current.amount.leftToPay <= 0) {
      return jsonErrorResponse({ result: 'EXPENSE_REIMBURSEMENT_REFUSED', expenseId: args.expenseId,
        reason: 'Only OPEN, APPROVED or PARTIAL expenses with subStatus NONE and positive remaining balance are supported. Nothing was sent.' });
    }
    if (Math.round(current.amount.leftToPay * 100) !== Math.round(args.expectedRemainingAmount * 100)) {
      return jsonErrorResponse({ result: 'EXPENSE_REMAINING_AMOUNT_MISMATCH', expenseId: args.expenseId,
        expectedRemainingAmount: args.expectedRemainingAmount, remainingAmount: current.amount.leftToPay,
        total: current.amount.total, reason: 'Approve the full remaining balance, not the original expense total or a partial payment. Nothing was sent.' });
    }
    const payload = { status: 'MARKED_REIMBURSED' };
    const revision = stateRevision(current);
    const gate = await confirmWrite(ctx, {
      args, tool: 'ofw_mark_expense_reimbursed', action: 'ofw.expense.mark-reimbursed',
      target: `expense:${args.expenseId}`, revision, payload, confirmToken: args.confirmToken,
      message: `Mark "${current.title}" fully reimbursed externally (${current.amount.leftToPay}). This cannot be undone and does not transfer money.`,
      preview: { expenseId: args.expenseId, title: current.title, authorUserId: current.author.userId,
        payerUserId: current.payer.userId, category: current.category, children: current.children,
        private: current.private, total: current.amount.total, totalOwed: current.amount.totalOwed,
        remainingAmount: current.amount.leftToPay, status: current.status, statusInfo: current.statusInfo,
        paymentType: current.paymentType,
        warning: 'Mark the FULL remaining balance reimbursed outside OFW. This cannot be undone. No money is transferred; no bank/payment action is performed.' },
    });
    if (gate) return gate;
    try {
      if (stateRevision(await read()) !== revision) {
        return jsonErrorResponse({ result: 'EXPENSE_CHANGED', expenseId: args.expenseId,
          reason: 'The expense changed after confirmation. Nothing was sent. Review it again before confirming.' });
      }
    } catch {
      return jsonErrorResponse({ result: 'EXPENSE_REIMBURSEMENT_REFUSED', expenseId: args.expenseId,
        reason: 'The immediate pre-write check failed. Nothing was sent.' });
    }
    try { await requestWrite(client, 'PUT', `${path}/status`, payload); }
    catch (e) {
      if (!(e instanceof UnconfirmedWriteError)) throw e;
      return unconfirmedWriteResponse(e, { result: 'EXPENSE_REIMBURSEMENT_UNCONFIRMED',
        what: `mark expense ${args.expenseId} reimbursed`, checkWith: 'the Expenses log on ourfamilywizard.com' });
    }
    try {
      const after = await read();
      if (after.statusInfo.baseStatus !== 'PAID' || after.amount.leftToPay !== 0
        || after.paymentType !== 'Marked reimbursed' || immutableRevision(after) !== immutableRevision(current)) {
        throw new Error('Paid status, external reimbursement marker, zero balance or unchanged expense fields could not be verified');
      }
      return jsonResponse({ result: 'EXPENSE_MARKED_REIMBURSED', expenseId: args.expenseId,
        verified: true, reimbursedAmount: current.amount.leftToPay, remainingAmount: 0, moneyTransferred: false });
    } catch (e) {
      return unconfirmedWriteResponse(new UnconfirmedWriteError(args.expenseId, e), {
        result: 'EXPENSE_REIMBURSEMENT_UNCONFIRMED', what: `verify reimbursement of expense ${args.expenseId}`,
        checkWith: 'the Expenses log on ourfamilywizard.com' });
    }
  });
}
