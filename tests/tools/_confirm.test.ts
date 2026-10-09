import { describe, expect, it, vi } from 'vitest';

vi.mock('@chrischall/mcp-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chrischall/mcp-utils')>();
  return { ...actual, confirmationFromEnv: vi.fn(actual.confirmationFromEnv) };
});

import { confirmationFromEnv } from '@chrischall/mcp-utils';
import { confirmWrite } from '../../src/tools/_confirm.js';
import { NO_ELICIT_CTX } from './_confirm-helpers.js';

describe('confirmWrite', () => {
  it('binds the gate to the tool arguments and declares the single OFW account (mcp-utils 3)', async () => {
    const args = { eventId: '9', includeFuture: true, confirmToken: undefined };
    const gate = await confirmWrite(NO_ELICIT_CTX as never, {
      args,
      tool: 'ofw_delete_event',
      action: 'ofw.event.delete',
      message: 'Review and confirm.',
      target: 'event:9',
      payload: { eventId: '9', includeFuture: true },
      preview: { eventId: '9' },
      confirmToken: undefined,
    });
    expect(gate).toBeDefined();
    const opts = vi.mocked(confirmationFromEnv).mock.calls[0]![0];
    expect(opts).toHaveProperty('account', undefined);
    expect(opts.args).toBe(args);
  });
});
