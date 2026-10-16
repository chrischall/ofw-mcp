import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertOfwUrl, BASE_URL, RECEIPT_HOST_SUFFIX } from '../src/protocol.js';

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

describe('mint.yaml egress allowlist matches the hosts the code fetches', () => {
  // The hosted registration's default-deny fence is mint.yaml `egress.allow`;
  // the code's own pre-flight checks are assertOfwUrl (API + login) and the
  // remote-receipt check in ofw_upload_expense_pdf. If the two lists drift,
  // a hosted tool passes its own checks and then dies on a network error.
  function mintEgress(): string[] {
    const text = readFileSync(fileURLToPath(new URL('../mint.yaml', import.meta.url)), 'utf8');
    const block = text.split(/^egress:\s*$/m)[1] ?? '';
    return [...block.matchAll(/^\s+-\s+(\S+)\s*$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ''));
  }

  it('lists exactly the OFW host and the receipt-URL wildcard', () => {
    expect(mintEgress().sort()).toEqual(
      [new URL(BASE_URL).host, `*${RECEIPT_HOST_SUFFIX}`].sort(),
    );
  });
});
