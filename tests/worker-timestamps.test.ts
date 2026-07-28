import { describe, it, expect } from 'vitest';
import { formatInstant, normalizeTimestampsInValue } from '../src/timestamps.js';

// Timestamp normalization now runs on every hosted-connector response, so it has
// to work inside workerd and not just Node. Two things could differ:
//
//  - `structuredClone`, which the non-mutating walk depends on. Cloning a live
//    cache row rather than rewriting it in place is what keeps normalization
//    from being observable on a later read.
//  - workerd's ICU timezone data. The whole point of using IANA names instead of
//    fixed offsets is that DST is resolved from that database; a runtime shipping
//    a trimmed ICU would silently label July as -05:00 and put a late-evening
//    send on the wrong calendar day — the exact failure this module exists to
//    prevent. A green Node suite would not catch it.
const ET = 'America/New_York';

describe('timestamp normalization under the Workers runtime', () => {
  it('resolves DST from IANA data rather than a fixed offset', () => {
    expect(formatInstant(new Date('2026-01-15T17:00:00Z'), ET).iso).toBe('2026-01-15T12:00:00-05:00');
    expect(formatInstant(new Date('2026-07-15T17:00:00Z'), ET).iso).toBe('2026-07-15T13:00:00-04:00');
  });

  it('renders a weekday-bearing display string', () => {
    const { display } = formatInstant(new Date('2026-07-28T03:36:00Z'), ET);
    expect(display).toContain('Mon');
    expect(display).toContain('Jul 27');
  });

  it('normalizes a naive OFW timestamp onto the correct calendar day', () => {
    const out = normalizeTimestampsInValue({ sentAt: '2026-07-27T23:31:09' }, ET);
    expect(out.sentAt).toBe('2026-07-27T23:31:09-04:00');
    expect(out.sentAtDisplay).toContain('Jul 27');
  });

  it('clones rather than mutating — structuredClone is available here', () => {
    const input = { sentAt: '2026-07-27T23:31:09', nested: { viewedAt: '2026-07-28T09:37:11' } };
    const out = normalizeTimestampsInValue(input, ET);
    expect(input.sentAt).toBe('2026-07-27T23:31:09');
    expect(input.nested.viewedAt).toBe('2026-07-28T09:37:11');
    expect(out).not.toBe(input);
    expect(out.nested).not.toBe(input.nested);
  });

  it('supports the non-default zones a DISPLAY_TZ override could name', () => {
    expect(formatInstant(new Date('2026-07-15T17:00:00Z'), 'America/Los_Angeles').iso)
      .toBe('2026-07-15T10:00:00-07:00');
    expect(formatInstant(new Date('2026-07-15T00:00:00Z'), 'Asia/Kolkata').iso)
      .toBe('2026-07-15T05:30:00+05:30');
  });
});
