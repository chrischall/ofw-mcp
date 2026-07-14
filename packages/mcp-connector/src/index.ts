import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpAgent } from 'agents/mcp';
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { handleAuthorize } from './login.js';
import type { ConnectorOptions } from './types.js';

export * from './types.js';
export { renderLoginPage } from './login-page.js';
export { handleAuthorize, parseLoginForm } from './login.js';

export function createConnector<Props extends Record<string, unknown>, Client>(
  opts: ConnectorOptions<Props, Client>,
): { Agent: typeof McpAgent; handler: OAuthProvider } {
  class ConnectorAgent extends McpAgent<any, unknown, Props> {
    server = new McpServer({ name: opts.name, version: opts.version });
    async init() {
      const client = opts.buildClient(this.props as Props, this.env);
      for (const register of opts.tools) register(this.server, client);
    }
  }

  const defaultHandler: ExportedHandler = {
    fetch: (request, env, _ctx) => {
      const url = new URL(request.url);
      if (url.pathname === '/authorize') return handleAuthorize(request, env, opts.auth);
      return new Response('Not found', { status: 404 });
    },
  };

  const handler = new OAuthProvider({
    apiHandlers: {
      '/mcp': ConnectorAgent.serve('/mcp') as any,
      '/sse': ConnectorAgent.serveSSE('/sse') as any,
    },
    defaultHandler: defaultHandler as any,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
  });

  // `ConnectorAgent` fixes Props to this call's type parameter, but `typeof McpAgent`
  // is universally quantified over Props in its constructor signature — a concrete
  // subclass can never satisfy that generically, so we cast at this fuzzy boundary.
  return { Agent: ConnectorAgent as unknown as typeof McpAgent, handler };
}
