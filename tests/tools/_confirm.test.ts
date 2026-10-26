import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@chrischall/mcp-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils')>();
  return { ...actual, confirmationFromEnv: vi.fn(actual.confirmationFromEnv) };
});

import { confirmationFromEnv } from '@chrischall/mcp-utils';
import { confirmWrite, type ConfirmWriteOptions } from '../../src/tools/_confirm.js';
import { CAN_ASK_CTX, NO_ELICIT_CTX } from './_confirm-helpers.js';

const options = (): ConfirmWriteOptions => ({
  args: { eventId: '9', includeFuture: true },
  tool: 'ofw_delete_event', action: 'ofw.event.delete', message: 'Review and confirm.',
  target: 'event:9', revision: 'revision-1', payload: { eventId: '9', includeFuture: true },
  preview: { eventId: '9', title: 'Synthetic event' }, confirmToken: undefined,
});
const gate = (opts: ConfirmWriteOptions, ctx: unknown = NO_ELICIT_CTX) => confirmWrite(ctx as never, opts);
const accepted = (requestState: unknown, action = 'accept', confirmed = true) => ({
  mcpReq: { ...CAN_ASK_CTX.mcpReq, requestState: () => requestState,
    inputResponses: { confirmation: { action, content: { confirmed } } } },
});
async function prompt(opts: ConfirmWriteOptions) {
  const result = await gate(opts, CAN_ASK_CTX);
  expect(result?.resultType).toBe('input_required');
  return (result as { requestState: string }).requestState;
}
async function token(opts: ConfirmWriteOptions) {
  const result = await gate(opts);
  const parsed = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
  expect(parsed.status).toBe('confirmation-required');
  return parsed.confirmToken as string;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('confirmWrite', () => {
  it('binds full effective state and declares the single OFW account (mcp-utils 3)', async () => {
    const opts = options();
    opts.args = { ...opts.args, confirmToken: undefined };
    expect(await gate(opts)).toBeDefined();
    const passed = vi.mocked(confirmationFromEnv).mock.calls[0]![0];
    expect(passed).toHaveProperty('account', undefined);
    expect(passed.args).toEqual({ tool: opts.tool, action: opts.action, args: { eventId: '9', includeFuture: true },
      target: opts.target, revision: opts.revision, payload: opts.payload, preview: opts.preview });
    expect(opts.args).toHaveProperty('confirmToken', undefined);
  });

  const changes: Array<[string, Partial<ConfirmWriteOptions>]> = [
    ['target', { target: 'event:10' }], ['revision', { revision: 'revision-2' }],
    ['payload', { payload: { eventId: '9', includeFuture: false } }],
    ['preview', { preview: { eventId: '9', title: 'Changed synthetic event' } }],
    ['args', { args: { eventId: '9', includeFuture: false } }],
    ['tool', { tool: 'other_tool' }], ['action', { action: 'other.action' }],
  ];
  it.each(changes)('re-prompts accepted elicitation on changed %s', async (_field, change) => {
    const opts = options();
    const requestState = await prompt(opts);
    expect(await gate({ ...opts, ...change }, accepted(requestState))).toMatchObject({ resultType: 'input_required' });
    // Re-approval of the freshly displayed state works, not an endless refusal.
    const freshState = await prompt({ ...opts, ...change });
    expect(await gate({ ...opts, ...change }, accepted(freshState))).toBeUndefined();
  });
  it.each(changes)('rejects fallback token on changed %s without spending the valid approval', async (_field, change) => {
    const opts = options();
    const confirmToken = await token(opts);
    expect(await gate({ ...opts, ...change, confirmToken })).toMatchObject({ isError: true });
    expect(await gate({ ...opts, confirmToken, args: { ...opts.args, confirmToken } })).toBeUndefined();
    expect(await gate({ ...opts, confirmToken })).toMatchObject({ isError: true });
  });
  it('accepts unchanged elicitation and ignores only the caller phase-2 confirmToken', async () => {
    const opts = options();
    const requestState = await prompt(opts);
    expect(await gate({ ...opts, args: { ...opts.args, confirmToken: 'transport-only' } }, accepted(requestState))).toBeUndefined();
  });
  it('refuses accepted elicitation with no echoed state', async () => {
    expect(await gate(options(), accepted(undefined))).toMatchObject({ isError: true });
  });
  it.each([['decline', true], ['cancel', true], ['accept', false]] as const)('does not authorize %s / checked=%s', async (action, confirmed) => {
    const opts = options();
    const requestState = await prompt(opts);
    expect(await gate(opts, accepted(requestState, action, confirmed))).toBeDefined();
  });
  it('expires both approval rails using the configured TTL', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MCP_CONFIRM_TTL_SECONDS', '1');
    const opts = options();
    const requestState = await prompt(opts);
    const confirmToken = await token(opts);
    vi.advanceTimersByTime(2000);
    expect(await gate(opts, accepted(requestState))).toMatchObject({ resultType: 'input_required' });
    expect(await gate({ ...opts, confirmToken })).toMatchObject({ isError: true });
  });
  it('routes elicitation-off clients through the bound single-use fallback', async () => {
    vi.stubEnv('MCP_CONFIRM_ELICITATION', 'off');
    const opts = options();
    const result = await gate(opts, CAN_ASK_CTX);
    const confirmToken = JSON.parse((result as { content: Array<{ text: string }> }).content[0].text).confirmToken;
    expect(confirmToken).toEqual(expect.any(String));
    expect(await gate({ ...opts, confirmToken, preview: { changed: true } }, CAN_ASK_CTX)).toMatchObject({ isError: true });
    expect(await gate({ ...opts, confirmToken }, CAN_ASK_CTX)).toBeUndefined();
    expect(await gate({ ...opts, confirmToken }, CAN_ASK_CTX)).toMatchObject({ isError: true });
  });
});
