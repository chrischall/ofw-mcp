import { describe, it, expect } from 'vitest';
import { renderLoginPage } from '../src/login-page.js';
import type { ConnectorAuth } from '../src/types.js';

const auth: ConnectorAuth<{ token: string }> = {
  service: 'Untappd',
  fields: [
    { name: 'username', label: 'Username' },
    { name: 'password', label: 'Password', type: 'password' },
  ],
  login: async () => ({ token: 'TOK' }),
  privacyNote: 'We never store your password.',
};

describe('renderLoginPage', () => {
  it('renders an input for each field', () => {
    const html = renderLoginPage(auth);
    expect(html).toContain('name="username"');
    expect(html).toContain('name="password"');
  });

  it('marks password fields with type="password"', () => {
    const html = renderLoginPage(auth);
    expect(html).toMatch(/name="password"[^>]*type="password"|type="password"[^>]*name="password"/);
  });

  it('defaults non-password fields to type="text"', () => {
    const html = renderLoginPage(auth);
    expect(html).toMatch(/name="username"[^>]*type="text"|type="text"[^>]*name="username"/);
  });

  it('shows the service name', () => {
    const html = renderLoginPage(auth);
    expect(html).toContain('Untappd');
  });

  it('shows the privacy note', () => {
    const html = renderLoginPage(auth);
    expect(html).toContain('We never store your password.');
  });

  it('shows the error text when passed', () => {
    const html = renderLoginPage(auth, { error: 'login failed' });
    expect(html).toContain('login failed');
  });

  it('omits any error markup when no error is passed', () => {
    const html = renderLoginPage(auth);
    expect(html).not.toContain('role="alert"');
  });

  it('carries the oauthReq through a hidden field', () => {
    const html = renderLoginPage(auth, { oauthReq: { clientId: 'c' } });
    const expected = btoa(JSON.stringify({ clientId: 'c' }));
    expect(html).toContain(`name="oauthReq" value="${expected}"`);
  });

  it('applies a provided accent color and derives readable button text', () => {
    const html = renderLoginPage({ ...auth, accent: '#FFC000' });
    expect(html).toContain('--accent: #FFC000');
    // #FFC000 is light → dark ink on the button
    expect(html).toContain('--accent-ink: #141414');
  });

  it('picks dark ink on a mid-range accent (L≈0.33), not the WCAG-crossover-violating white', () => {
    // #0ea5e9 has relative luminance ~0.329 — comfortably above the WCAG
    // AA contrast crossover (~0.179 for white-vs-black text) but below the
    // old, too-high 0.5 threshold. White text on this background reads
    // poorly; dark text is the correct, more-readable choice.
    const html = renderLoginPage({ ...auth, accent: '#0ea5e9' });
    expect(html).toContain('--accent-ink: #141414');
  });

  it('falls back to the neutral accent when none/invalid is given', () => {
    expect(renderLoginPage(auth)).toContain('--accent: #4f46e5');
    expect(renderLoginPage({ ...auth, accent: 'red; }evil' })).toContain('--accent: #4f46e5');
  });

  it('is a styled, theme-aware document (inline CSS, dark mode, reduced motion, no external assets)', () => {
    const html = renderLoginPage(auth);
    expect(html).toContain('<style>');
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('prefers-reduced-motion');
    expect(html).not.toContain('http://');
    expect(html).not.toContain('https://');
  });

  it('sets autocomplete + autofocus for password-manager friendliness', () => {
    const html = renderLoginPage(auth);
    expect(html).toMatch(/name="username"[^>]*autocomplete="username"/);
    expect(html).toMatch(/name="password"[^>]*autocomplete="current-password"/);
    expect(html).toContain('autofocus');
  });
});
