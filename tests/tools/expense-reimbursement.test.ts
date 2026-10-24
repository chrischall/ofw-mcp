import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { OFWClient } from '../../src/client.js';
import { registerExpenseTools } from '../../src/tools/expenses.js';
import { callPreview, NO_ELICIT_CTX, CAN_ASK_CTX, type GatedHandler } from './_confirm-helpers.js';

const name = 'ofw_mark_expense_reimbursed';
const args = { expenseId: 81001, expectedRemainingAmount: 48.5 };
const path = '/pub/v2/expense/expenses/81001';
const expense = () => ({
  id: 81001, title: 'Synthetic activity supplies', author: { userId: 82001 }, payer: { userId: 82002 },
  amount: { total: 96.99, totalOwed: 48.5, leftToPay: 48.5 },
  status: 'Open', statusInfo: { baseStatus: 'OPEN', subStatus: 'NONE' }, paymentType: '', private: false,
  category: { id: 83001, split: { parentSplit: '50', coparentSplit: '50' } },
  children: [{ userId: 84001 }], fileId: 85001,
});
const paid = () => ({ ...expense(), amount: { ...expense().amount, leftToPay: 0 }, status: 'Paid',
  statusInfo: { baseStatus: 'PAID', subStatus: 'NONE' }, paymentType: 'Marked reimbursed' });
function setup() {
  const client = new OFWClient();
  const request = vi.spyOn(client, 'request').mockResolvedValue(expense());
  const handlers = new Map<string, GatedHandler>();
  const configs = new Map<string, { inputSchema: z.ZodType; annotations: Record<string, boolean> }>();
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  vi.spyOn(server, 'registerTool').mockImplementation((n, c, h) => {
    handlers.set(n, h as unknown as GatedHandler);
    configs.set(n, c as unknown as typeof configs extends Map<string, infer C> ? C : never);
    return undefined as never;
  });
  registerExpenseTools(server, client);
  return { request, handlers, config: configs.get(name)!, handler: handlers.get(name)! };
}
const body = (result: Awaited<ReturnType<GatedHandler>>) => JSON.parse(result.content[0].text);
beforeEach(() => { vi.stubEnv('OFW_WRITE_MODE', 'all'); vi.stubEnv('OFW_EXPENSE_UPLOAD_ONLY', 'false'); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe(name, () => {
  it('allows normal derived amount-display changes while verifying a settled balance', async () => {
    const { handler, request } = setup();
    const current = { ...expense(), amount: { ...expense().amount, totalFmt: '$96.99',
      totalOwedFmt: '$48.50', leftToPayFmt: '$48.50', description: 'Parent owes', color: '#112233' } };
    const after = { ...paid(), amount: { ...current.amount, leftToPay: 0,
      leftToPayFmt: '$0.00', description: 'Parent paid', color: '#334455' } };
    request.mockResolvedValue(current);
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce(current).mockResolvedValueOnce(current).mockResolvedValueOnce(null).mockResolvedValueOnce(after);
    expect(body(await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX))).toMatchObject({
      result: 'EXPENSE_MARKED_REIMBURSED', verified: true, remainingAmount: 0,
    });
    expect(request.mock.calls.filter((c) => c[0] === 'PUT')).toHaveLength(1);
  });
  it('registers the irreversible external-only action and previews without writing', async () => {
    const { handler, request, config } = setup();
    expect(config).toBeDefined();
    expect(config.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    const preview = await callPreview(handler, args);
    expect(preview.preview).toMatchObject({ title: expense().title, total: 96.99, totalOwed: 48.5, remainingAmount: 48.5,
      authorUserId: 82001, payerUserId: 82002 });
    expect(JSON.stringify(preview.preview)).toMatch(/cannot be undone/i);
    expect(request.mock.calls).toEqual([['GET', path]]);
  });

  it.each(['OPEN', 'APPROVED', 'PARTIAL'])('marks %s with only the verified status body and verifies detail', async (baseStatus) => {
    const { handler, request } = setup();
    const current = { ...expense(), statusInfo: { baseStatus, subStatus: 'NONE' } };
    request.mockResolvedValue(current);
    const preview = await callPreview(handler, args);
    request.mockClear();
    request.mockResolvedValueOnce(current).mockResolvedValueOnce(current).mockResolvedValueOnce(null).mockResolvedValueOnce(paid());
    expect(body(await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX))).toMatchObject({
      result: 'EXPENSE_MARKED_REIMBURSED', verified: true, reimbursedAmount: 48.5, remainingAmount: 0, moneyTransferred: false,
    });
    expect(request.mock.calls).toEqual([['GET', path], ['GET', path], ['PUT', `${path}/status`, { status: 'MARKED_REIMBURSED' }], ['GET', path]]);
    expect(request.mock.calls.some((c) => /payments|bank/.test(c[1]))).toBe(false);
  });

  it.each(['none', 'drafts'])('does not register in %s mode', (mode) => {
    vi.stubEnv('OFW_WRITE_MODE', mode);
    expect(setup().handlers.has(name)).toBe(false);
  });
  it('does not expand upload-only mode', () => {
    vi.stubEnv('OFW_EXPENSE_UPLOAD_ONLY', 'true');
    expect(setup().handlers.has(name)).toBe(false);
  });
  it('remains available on the non-upload-only expense surface', () => {
    vi.stubEnv('OFW_EXPENSE_ONLY', 'true');
    expect(setup().handlers.has(name)).toBe(true);
  });
  it.each([0, -1, 0.001, 1.001, 1e-10, Infinity, NaN, '48.50', 1e16])('rejects invalid expected amount %s', (amount) => {
    expect(setup().config.inputSchema.safeParse({ ...args, expectedRemainingAmount: amount }).success).toBe(false);
  });
  it.each([0.01, 0.29, 48.5, 96.99])('accepts exact currency amount %s', (amount) => {
    expect(setup().config.inputSchema.safeParse({ ...args, expectedRemainingAmount: amount }).success).toBe(true);
  });
  it.each([0, -1, 1.5, '81001', Infinity])('rejects invalid id %s', (expenseId) => {
    expect(setup().config.inputSchema.safeParse({ ...args, expenseId }).success).toBe(false);
  });
  it('requires an amount and validates token shape', () => {
    const { config } = setup();
    expect(config.inputSchema.safeParse({ expenseId: args.expenseId }).success).toBe(false);
    expect(config.inputSchema.safeParse({ ...args, confirmToken: 123 }).success).toBe(false);
    const token = z.toJSONSchema(config.inputSchema).properties?.confirmToken;
    expect(JSON.stringify(token)).toContain('ONLY for the two-step confirmation fallback');
  });
  it.each([96.99, 24.25])('refuses full-total or partial amount %s', async (amount) => {
    const { handler, request } = setup();
    expect(body(await handler({ ...args, expectedRemainingAmount: amount }, NO_ELICIT_CTX)).result).toBe('EXPENSE_REMAINING_AMOUNT_MISMATCH');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('does not require confirmation or write when already paid, including a real payment marker', async () => {
    const { handler, request } = setup();
    request.mockResolvedValue({ ...paid(), paymentType: 'Electronic payment' });
    expect(body(await handler(args, NO_ELICIT_CTX))).toMatchObject({ result: 'ALREADY_PAID', changed: false });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([
    null, {}, { ...expense(), id: 81002 }, { ...expense(), amount: 96.99 },
    { ...expense(), amount: { ...expense().amount, total: Infinity } },
    { ...expense(), amount: { ...expense().amount, totalOwed: '48.50' } },
    { ...expense(), amount: { ...expense().amount, leftToPay: NaN } },
    { ...expense(), amount: { ...expense().amount, leftToPay: 0.001 } },
    { ...expense(), amount: { ...expense().amount, leftToPay: 49 } },
    { ...expense(), amount: { ...expense().amount, totalOwed: 100 } },
    { ...expense(), statusInfo: undefined }, { ...expense(), status: '' },
    { ...expense(), statusInfo: { baseStatus: 'OPEN', subStatus: 'PAYMENT_PENDING' } },
    { ...expense(), statusInfo: { baseStatus: 'OPEN' } },
    { ...expense(), statusInfo: { baseStatus: 'UNKNOWN', subStatus: 'NONE' } },
    { ...expense(), statusInfo: { baseStatus: 'PAID', subStatus: 'NONE' } },
    { ...expense(), amount: { ...expense().amount, leftToPay: 0 } },
    { ...expense(), author: {} }, { ...expense(), payer: {} }, { ...expense(), category: {} },
    { ...expense(), children: [] }, { ...expense(), paymentType: undefined },
  ])('fails closed for unsafe detail %#', async (detail) => {
    const { handler, request } = setup();
    request.mockResolvedValue(detail);
    const result = await handler(args, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    expect(body(result).result).toBe('EXPENSE_REIMBURSEMENT_REFUSED');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('refuses a failed initial read', async () => {
    const { handler, request } = setup();
    request.mockRejectedValue(new Error('offline'));
    expect(body(await handler(args, NO_ELICIT_CTX)).result).toBe('EXPENSE_REIMBURSEMENT_REFUSED');
  });
  it('binds all current detail fields into the token', async () => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValue({ ...expense(), fileId: 85002 });
    expect((await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX)).isError).toBe(true);
    expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
  it('binds caller arguments and refuses token replay', async () => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce({ ...expense(), id: 81002 });
    const changedArgs = await handler({ ...args, expenseId: 81002, confirmToken: preview.confirmToken }, NO_ELICIT_CTX);
    expect(changedArgs.isError).toBe(true);
    expect(body(changedArgs).result).not.toBe('EXPENSE_REIMBURSEMENT_REFUSED');
    request.mockResolvedValueOnce(expense()).mockResolvedValueOnce(expense()).mockResolvedValueOnce(null).mockResolvedValueOnce(paid());
    await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX);
    request.mockClear();
    expect((await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX)).isError).toBe(true);
    expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
  it.each(['refuse', 'misspelled-mode'])('honors confirmation mode %s without mutation', async (mode) => {
    vi.stubEnv('MCP_CONFIRM_MODE', mode);
    const { handler, request } = setup();
    expect(body(await handler(args, NO_ELICIT_CTX))).toMatchObject({ reason: 'confirmation-unsupported' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['title', 'fileId'] as const)('rejects accepted elicitation after %s changes with unchanged args', async (field) => {
    const { handler, request } = setup();
    const prompt = await handler(args, CAN_ASK_CTX) as unknown as { resultType: string; requestState: string };
    expect(prompt.resultType).toBe('input_required');
    expect(prompt.requestState).toEqual(expect.any(String));
    expect(request.mock.calls).toEqual([['GET', path]]);
    const changed = { ...expense(), [field]: field === 'title' ? 'Changed synthetic title' : 85002 };
    request.mockResolvedValue(changed);
    request.mockClear();
    const result = await handler(args, {
      mcpReq: { ...CAN_ASK_CTX.mcpReq, requestState: () => prompt.requestState,
        inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } } },
    });
    expect(request.mock.calls.filter((c) => c[0] === 'PUT')).toHaveLength(0);
    expect(result.resultType).toBe('input_required');
    expect(request.mock.calls).toEqual([['GET', path]]);
  });
  it('accepts unchanged elicitation state and performs exactly one verified status PUT', async () => {
    const { handler, request } = setup();
    const prompt = await handler(args, CAN_ASK_CTX) as unknown as { requestState: string };
    expect(prompt.requestState).toEqual(expect.any(String));
    request.mockClear();
    request.mockResolvedValueOnce(expense()).mockResolvedValueOnce(expense()).mockResolvedValueOnce(null).mockResolvedValueOnce(paid());
    const result = await handler(args, {
      mcpReq: { ...CAN_ASK_CTX.mcpReq, requestState: () => prompt.requestState,
        inputResponses: { confirmation: { action: 'accept', content: { confirmed: true } } } },
    });
    expect(body(result)).toMatchObject({ result: 'EXPENSE_MARKED_REIMBURSED', verified: true });
    expect(request.mock.calls).toEqual([['GET', path], ['GET', path],
      ['PUT', `${path}/status`, { status: 'MARKED_REIMBURSED' }], ['GET', path]]);
  });
  it('asks capable clients rather than writing', async () => {
    const { handler, request } = setup();
    expect((await handler(args, CAN_ASK_CTX)).resultType).toBe('input_required');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('refuses an invented token without writing', async () => {
    const { handler, request } = setup();
    expect((await handler({ ...args, confirmToken: 'invented' }, NO_ELICIT_CTX)).isError).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each(['drift', 'failure', 'malformed'])('refuses pre-write %s after approval', async (scenario) => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce(expense());
    if (scenario === 'failure') request.mockRejectedValueOnce(new Error('offline'));
    else request.mockResolvedValueOnce(scenario === 'drift' ? { ...expense(), extra: true } : {});
    const result = body(await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX));
    expect(result.result).toBe(scenario === 'drift' ? 'EXPENSE_CHANGED' : 'EXPENSE_REIMBURSEMENT_REFUSED');
    expect(request.mock.calls.every((c) => c[0] === 'GET')).toBe(true);
  });
  it.each([new Error('timeout'), new Error('OFW API error: 500'), new Error('OFW API error: 408'), 'network lost'])('reports ambiguous mutation failure without replay: %s', async (error) => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce(expense()).mockResolvedValueOnce(expense()).mockRejectedValueOnce(error);
    const result = await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    expect(body(result)).toMatchObject({ result: 'EXPENSE_REIMBURSEMENT_UNCONFIRMED', mayHaveLanded: true });
    expect(request.mock.calls.filter((c) => c[0] === 'PUT')).toHaveLength(1);
  });
  it.each(['OFW API error: 403 Forbidden', 'OFW API error: 409 Conflict', 'Rate limited by OFW API'])('propagates definitive rejection: %s', async (error) => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce(expense()).mockResolvedValueOnce(expense()).mockRejectedValueOnce(new Error(error));
    await expect(handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX)).rejects.toThrow(error);
    expect(request.mock.calls.filter((c) => c[0] === 'PUT')).toHaveLength(1);
  });
  it.each([
    expense(), { ...paid(), statusInfo: { baseStatus: 'OPEN', subStatus: 'NONE' } },
    { ...paid(), amount: { ...paid().amount, leftToPay: 1 } }, { ...paid(), paymentType: '' },
    { ...paid(), title: 'Changed title' }, { ...paid(), fileId: 85002 },
    { ...paid(), id: 81002 }, {},
  ])('reports unverified readback %# as potentially landed', async (after) => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce(expense()).mockResolvedValueOnce(expense()).mockResolvedValueOnce(null).mockResolvedValueOnce(after);
    expect(body(await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX))).toMatchObject({
      result: 'EXPENSE_REIMBURSEMENT_UNCONFIRMED', mayHaveLanded: true,
    });
    expect(request.mock.calls.filter((c) => c[0] === 'PUT')).toHaveLength(1);
  });
  it('reports a failed post-write GET as potentially landed', async () => {
    const { handler, request } = setup();
    const preview = await callPreview(handler, args);
    request.mockResolvedValueOnce(expense()).mockResolvedValueOnce(expense()).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
    expect(body(await handler({ ...args, confirmToken: preview.confirmToken }, NO_ELICIT_CTX)).mayHaveLanded).toBe(true);
  });
});
