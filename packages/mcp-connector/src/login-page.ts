import type { ConnectorAuth } from './types.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A safe CSS color: only accept a #rgb/#rrggbb hex, else fall back. */
function safeAccent(value: string | undefined, fallback: string): string {
  return value && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value) ? value : fallback;
}

/** Readable text color on top of a hex background (dark ink on light accents, white on dark). */
function inkOn(hex: string): string {
  let h = hex.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // 0.179 is the WCAG contrast crossover: the luminance above which black
  // text (#141414) contrasts better than white against the background,
  // rather than the naive 0.5 midpoint — so mid-range accents (e.g. a
  // saturated blue at L≈0.3) correctly get dark ink instead of white.
  return L > 0.179 ? '#141414' : '#ffffff';
}

/** Best-guess autocomplete so password managers cooperate. */
function autocompleteFor(name: string, isPassword: boolean): string {
  if (isPassword) return 'current-password';
  if (/user|email|login|account/i.test(name)) return 'username';
  return 'off';
}

export interface RenderLoginPageOptions {
  error?: string;
  oauthReq?: unknown;
}

/**
 * Renders the login form for a connector's own service credentials.
 * Auth-agnostic: knows nothing about any particular service beyond the field
 * list, the service name, an optional accent, and an optional privacy note.
 * Fully self-contained (inline CSS, no external assets) so it renders under a
 * strict Worker CSP; theme-aware, accessible, and responsive.
 */
export function renderLoginPage<Props>(auth: ConnectorAuth<Props>, options: RenderLoginPageOptions = {}): string {
  const { error, oauthReq } = options;
  const encodedOauthReq = oauthReq !== undefined ? btoa(JSON.stringify(oauthReq)) : '';
  const service = escapeHtml(auth.service);
  const accent = safeAccent(auth.accent, '#4f46e5');
  const accentInk = inkOn(accent);

  const fieldsHtml = auth.fields
    .map((field, i) => {
      const isPassword = field.type === 'password';
      const type = isPassword ? 'password' : 'text';
      const name = escapeHtml(field.name);
      const extras = isPassword ? '' : ' autocapitalize="none" autocorrect="off" spellcheck="false"';
      return `      <div class="field">
        <label for="f-${name}">${escapeHtml(field.label)}</label>
        <input id="f-${name}" name="${name}" type="${type}" required autocomplete="${autocompleteFor(field.name, isPassword)}"${i === 0 ? ' autofocus' : ''}${extras} />
      </div>`;
    })
    .join('\n');

  const errorHtml = error
    ? `<div class="error" role="alert"><svg viewBox="0 0 20 20" aria-hidden="true" width="16" height="16"><path fill="currentColor" d="M10 1.7 1 18h18L10 1.7Zm0 5.6a.9.9 0 0 1 .9.9v3.6a.9.9 0 0 1-1.8 0V8.2a.9.9 0 0 1 .9-.9Zm0 7.3a1 1 0 1 1 0 2 1 1 0 0 1 0-2Z"/></svg><span>${escapeHtml(error)}</span></div>`
    : '';

  const privacyHtml = auth.privacyNote
    ? `<p class="privacy"><svg viewBox="0 0 20 20" aria-hidden="true" width="13" height="13"><path fill="currentColor" d="M10 1a4 4 0 0 0-4 4v2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm-2 6V5a2 2 0 1 1 4 0v2H8Z"/></svg><span>${escapeHtml(auth.privacyNote)}</span></p>`
    : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Connect to ${service}</title>
    <style>
      :root {
        --accent: ${accent};
        --accent-ink: ${accentInk};
        --bg: #f4f3f0;
        --card: #ffffff;
        --ink: #16150f;
        --muted: #6d6a60;
        --border: #e5e2da;
        --input-bg: #fbfaf7;
        --err-bg: #fef3f2;
        --err-ink: #b42318;
        --err-border: #fecdc9;
        --ring: color-mix(in srgb, var(--accent) 35%, transparent);
        --shadow: 0 1px 2px rgba(20,18,10,.04), 0 12px 32px -12px rgba(20,18,10,.18);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #0e0e11;
          --card: #17171c;
          --ink: #f3f2ee;
          --muted: #9c9aa4;
          --border: #292930;
          --input-bg: #1e1e24;
          --err-bg: #2a1614;
          --err-ink: #f9a29b;
          --err-border: #55302c;
          --shadow: 0 1px 2px rgba(0,0,0,.3), 0 16px 40px -12px rgba(0,0,0,.6);
        }
      }
      * { box-sizing: border-box; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        color: var(--ink);
        background:
          radial-gradient(120% 80% at 50% -10%, color-mix(in srgb, var(--accent) 12%, transparent), transparent 60%),
          var(--bg);
        display: grid;
        place-items: center;
        padding: 24px;
        -webkit-font-smoothing: antialiased;
      }
      .card {
        width: 100%;
        max-width: 400px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        box-shadow: var(--shadow);
        overflow: hidden;
        animation: rise .35s cubic-bezier(.2,.7,.2,1) both;
      }
      .card::before { content: ""; display: block; height: 3px; background: var(--accent); }
      .inner { padding: 34px 32px 28px; }
      .eyebrow {
        display: inline-flex; align-items: center; gap: 6px;
        font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase;
        color: var(--muted); margin: 0 0 14px;
      }
      .eyebrow svg { color: var(--accent); }
      h1 { margin: 0; font-size: 25px; font-weight: 700; letter-spacing: -.02em; line-height: 1.15; }
      .sub { margin: 8px 0 0; color: var(--muted); font-size: 14.5px; line-height: 1.5; }
      form { margin: 24px 0 0; }
      .field { margin: 0 0 15px; }
      label { display: block; font-size: 13px; font-weight: 550; margin: 0 0 7px; color: var(--ink); }
      input {
        width: 100%; height: 44px; padding: 0 13px;
        font-size: 15px; color: var(--ink);
        background: var(--input-bg);
        border: 1px solid var(--border); border-radius: 10px;
        outline: none; transition: border-color .12s, box-shadow .12s;
      }
      input:focus-visible { border-color: var(--accent); box-shadow: 0 0 0 3.5px var(--ring); }
      input::placeholder { color: var(--muted); }
      button {
        width: 100%; height: 46px; margin-top: 6px;
        font-size: 15px; font-weight: 600; font-family: inherit;
        color: var(--accent-ink); background: var(--accent);
        border: 0; border-radius: 10px; cursor: pointer;
        transition: filter .12s, transform .04s;
      }
      button:hover { filter: brightness(1.06) saturate(1.05); }
      button:active { transform: translateY(1px); }
      button:focus-visible { outline: none; box-shadow: 0 0 0 3.5px var(--ring); }
      .error {
        display: flex; gap: 9px; align-items: flex-start;
        margin: 0 0 20px; padding: 11px 13px;
        font-size: 13.5px; line-height: 1.45;
        color: var(--err-ink); background: var(--err-bg);
        border: 1px solid var(--err-border); border-radius: 10px;
      }
      .error svg { flex: none; margin-top: 1px; }
      .privacy {
        display: flex; gap: 8px; align-items: flex-start;
        margin: 20px 0 0; color: var(--muted); font-size: 12.5px; line-height: 1.5;
      }
      .privacy svg { flex: none; margin-top: 2px; color: var(--muted); }
      @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { .card { animation: none; } * { transition: none !important; } }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="inner">
        <p class="eyebrow"><svg viewBox="0 0 20 20" aria-hidden="true" width="12" height="12"><path fill="currentColor" d="M10 1a4 4 0 0 0-4 4v2H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1V5a4 4 0 0 0-4-4Zm-2 6V5a2 2 0 1 1 4 0v2H8Z"/></svg>Secure sign-in</p>
        <h1>Connect to ${service}</h1>
        <p class="sub">Sign in with your ${service} account to authorize access.</p>
        ${errorHtml}
        <form method="post">
${fieldsHtml}
          <input type="hidden" name="oauthReq" value="${escapeHtml(encodedOauthReq)}" />
          <button type="submit">Authorize ${service}</button>
        </form>
        ${privacyHtml}
      </div>
    </main>
  </body>
</html>`;
}
