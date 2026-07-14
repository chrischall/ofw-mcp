export interface LoginField {
  name: string;
  label: string;
  type?: 'text' | 'password';
}

export interface ConnectorAuth<Props> {
  /** Login-page branding, e.g. "Untappd". */
  service: string;
  fields: LoginField[];
  /** Verifies credentials and returns the OAuth props to store. Throws on bad creds. */
  login(fields: Record<string, string>, env: any): Promise<Props>;
  /** One-line note shown under the form. */
  privacyNote?: string;
  /** Brand accent as a hex color (e.g. "#FFC000") for the login page's button, focus ring, and tint. Optional — a neutral is used if absent. */
  accent?: string;
}

export interface ConnectorOptions<Props extends Record<string, unknown>, Client> {
  name: string;
  version: string;
  auth: ConnectorAuth<Props>;
  buildClient(props: Props, env: any): Client;
  tools: Array<(server: any, client: Client) => void>;
}
