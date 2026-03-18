import { config as loadDotenv } from 'dotenv';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: join(__dirname, '..', '.env'), override: false });

const BASE_URL = 'https://ofw.ourfamilywizard.com';

const STATIC_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
  Accept: 'application/json',
  'Content-Type': 'application/json',
} as const;

interface LoginResponse {
  auth: string; // Bearer token for all subsequent API calls
  redirectUrl: string;
}

export class OFWClient {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.ensureAuthenticated();
    return this.doRequest<T>(method, path, body, false);
  }

  private async doRequest<T>(
    method: string,
    path: string,
    body: unknown,
    isRetry: boolean
  ): Promise<T> {
    const isFormData = body instanceof FormData;
    const headers: Record<string, string> = {
      'ofw-client': 'WebApplication',
      'ofw-version': '1.0.0',
      Accept: 'application/json',
      Authorization: `Bearer ${this.token!}`,
    };
    if (!isFormData) headers['Content-Type'] = 'application/json';

    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: isFormData ? body : JSON.stringify(body) } : {}),
    });

    if (response.status === 401 && !isRetry) {
      this.token = null;
      this.tokenExpiry = null;
      await this.ensureAuthenticated();
      return this.doRequest<T>(method, path, body, true);
    }

    if (response.status === 429) {
      if (!isRetry) {
        await new Promise<void>((r) => setTimeout(r, 2000));
        return this.doRequest<T>(method, path, body, true);
      }
      throw new Error('Rate limited by OFW API');
    }

    if (!response.ok) {
      throw new Error(
        `OFW API error: ${response.status} ${response.statusText} for ${method} ${path}`
      );
    }

    return response.json() as Promise<T>;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.isTokenExpiredSoon()) return;
    await this.login();
  }

  private async login(): Promise<void> {
    const username = process.env.OFW_USERNAME;
    const password = process.env.OFW_PASSWORD;
    if (!username || !password) {
      throw new Error('OFW_USERNAME and OFW_PASSWORD must be set');
    }

    // Spring Security requires a SESSION cookie before accepting the login POST.
    // GET /ofw/login.form with redirect:manual to capture the Set-Cookie from the 303 response.
    const initResponse = await fetch(`${BASE_URL}/ofw/login.form`, {
      headers: { 'ofw-client': 'WebApplication', 'ofw-version': '1.0.0' },
      redirect: 'manual',
    });
    // Extract just the SESSION=value part (strip attributes like Path, Secure, etc.)
    const setCookie = initResponse.headers.get('set-cookie') ?? '';
    const sessionCookie = setCookie.split(';')[0]; // split always returns a string; empty string is falsy

    const response = await fetch(`${BASE_URL}/ofw/login`, {
      method: 'POST',
      headers: {
        ...STATIC_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      },
      body: new URLSearchParams({
        submit: 'Sign In',
        _eventId: 'submit',
        username: username,
        password,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(`OFW login failed: ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
      const body = await response.text();
      throw new Error(`OFW login returned unexpected response (${contentType}): ${body.substring(0, 200)}`);
    }

    const data = (await response.json()) as LoginResponse;
    this.token = data.auth;
    // Token expiry not returned by login endpoint; use 6h as a safe default
    this.tokenExpiry = new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  private isTokenExpiredSoon(): boolean {
    if (!this.token || !this.tokenExpiry) return true;
    return this.tokenExpiry.getTime() - Date.now() < 5 * 60 * 1000;
  }
}

export const client = new OFWClient();
