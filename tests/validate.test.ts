import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { parseOFW } from '../src/validate.js';

const Schema = z.looseObject({
  id: z.number(),
  subject: z.string().optional(),
});

afterEach(() => vi.restoreAllMocks());

describe('parseOFW', () => {
  it('returns the parsed value on success, preserving unknown keys (loose)', () => {
    const out = parseOFW(Schema, { id: 1, subject: 'S', extra: 'kept' }, 'GET /x');
    expect(out).toEqual({ id: 1, subject: 'S', extra: 'kept' });
  });

  it('lenient (default): warns to stderr and returns the raw value on mismatch', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = { id: 'not-a-number', subject: 5 };
    const out = parseOFW(Schema, raw, 'GET /pub/v3/messages');
    expect(out).toBe(raw); // raw passthrough, not a partial parse
    expect(err).toHaveBeenCalledTimes(1);
    const msg = err.mock.calls[0][0] as string;
    expect(msg).toContain('OFW response for GET /pub/v3/messages failed validation');
    expect(msg).toContain('id:');
    expect(msg).toContain('subject:');
  });

  it('strict: throws with the endpoint context and issue paths', () => {
    expect(() => parseOFW(Schema, { id: 'x' }, 'POST /pub/v3/messages', 'strict'))
      .toThrow(/OFW response for POST \/pub\/v3\/messages failed validation: id:/);
  });

  it('labels root-level mismatches as (root)', () => {
    expect(() => parseOFW(Schema, 'a string', 'GET /x', 'strict'))
      .toThrow(/\(root\):/);
  });

  it('strict success returns the parsed value', () => {
    expect(parseOFW(Schema, { id: 7 }, 'GET /x', 'strict')).toEqual({ id: 7 });
  });
});
