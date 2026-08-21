import { describe, it, expect } from 'vitest';
import { assertOfwUrl, BASE_URL } from '../src/protocol.js';

describe('assertOfwUrl (egress allowlist)', () => {
  it('allows URLs on the OFW host', () => {
    expect(() => assertOfwUrl(`${BASE_URL}/pub/v3/messages`)).not.toThrow();
    expect(() => assertOfwUrl(`${BASE_URL}/ofw/login`)).not.toThrow();
  });

  it('rejects any other host', () => {
    expect(() => assertOfwUrl('https://evil.com/steal')).toThrow(/non-OFW host "evil.com"/);
  });

  it('rejects a userinfo-splice that resolves to a foreign host', () => {
    // `…ourfamilywizard.com@evil.com` — the real host is evil.com.
    expect(() => assertOfwUrl('https://ofw.ourfamilywizard.com@evil.com/x'))
      .toThrow(/non-OFW host "evil.com"/);
  });

  it('rejects a malformed URL', () => {
    expect(() => assertOfwUrl('not a url')).toThrow(/malformed request URL/);
  });
});
