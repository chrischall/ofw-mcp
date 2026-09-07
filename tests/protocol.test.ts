import { describe, it, expect } from 'vitest';
import { assertOfwUrl, BASE_URL } from '../src/protocol.js';

describe('assertOfwUrl (egress allowlist)', () => {
  it('allows URLs on the OFW host', () => {
    expect(() => assertOfwUrl(`${BASE_URL}/pub/v3/messages`)).not.toThrow();
    expect(() => assertOfwUrl(`${BASE_URL}/ofw/login`)).not.toThrow();
  });

  it('rejects any other host', () => {
    expect(() => assertOfwUrl('https://evil.com/steal')).toThrow(/non-OFW host "evil\.com"/);
  });

  it('rejects an authority that only looks like OFW', () => {
    // `…ourfamilywizard.com@evil.com` parses with host evil.com. The current
    // call sites cannot produce this — every path begins with '/', so the '@'
    // can never reach the authority — which is exactly the invariant this
    // guard is here to keep true through a later refactor.
    expect(() => assertOfwUrl('https://ofw.ourfamilywizard.com@evil.com/x'))
      .toThrow(/non-OFW host "evil\.com"/);
    expect(() => assertOfwUrl('https://ofw.ourfamilywizard.com.evil.com/x'))
      .toThrow(/non-OFW host "ofw\.ourfamilywizard\.com\.evil\.com"/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertOfwUrl('not a url')).toThrow(/malformed request URL/);
  });
});
