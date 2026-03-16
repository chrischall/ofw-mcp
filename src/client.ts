import 'dotenv/config';

const BASE_URL = 'https://ofw.ourfamilywizard.com';

const STATIC_HEADERS = {
  'ofw-client': 'WebApplication',
  'ofw-version': '1.0.0',
  Accept: 'application/json',
  'Content-Type': 'application/json',
} as const;

interface LoginResponse {
  token: string;
  tokenExpiry?: string; // observed in localStorage; update from FINDINGS.md if different
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
    const response = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...STATIC_HEADERS,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
    const email = process.env.OFW_EMAIL;
    const password = process.env.OFW_PASSWORD;
    if (!email || !password) {
      throw new Error('OFW_EMAIL and OFW_PASSWORD must be set');
    }

    // Endpoint and field names based on localStorage observation. Update from FINDINGS.md if needed.
    const response = await fetch(`${BASE_URL}/pub/v1/auth/login`, {
      method: 'POST',
      headers: STATIC_HEADERS,
      body: JSON.stringify({ username: email, password }),
    });

    if (!response.ok) {
      throw new Error(`OFW login failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as LoginResponse;
    this.token = data.token;
    // Default to 6h if expiry not returned; update field name after Task 1
    this.tokenExpiry = data.tokenExpiry
      ? new Date(data.tokenExpiry)
      : new Date(Date.now() + 6 * 60 * 60 * 1000);
  }

  private isTokenExpiredSoon(): boolean {
    if (!this.token || !this.tokenExpiry) return true;
    return this.tokenExpiry.getTime() - Date.now() < 5 * 60 * 1000;
  }
}

export const client = new OFWClient();
