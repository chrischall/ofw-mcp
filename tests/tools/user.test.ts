import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let handlers: Map<string, ToolHandler>;

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function setup(client: OFWClient) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerUserTools(server, client);
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_profile', () => {
  it('calls /pub/v2/profiles', async () => {
    const profiles = { user: { id: 1, name: 'Chris' }, coParent: { id: 2, name: 'Jane' } };
    const client = makeClient(profiles);
    setup(client);

    const result = await handlers.get('ofw_get_profile')!({});

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/profiles');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(profiles);
  });
});

describe('ofw_get_notifications', () => {
  it('calls /pub/v1/users/useraccountstatus', async () => {
    const status = { unreadMessages: 3, upcomingEvents: 1, outstandingExpenses: 2 };
    const client = makeClient(status);
    setup(client);

    const result = await handlers.get('ofw_get_notifications')!({});

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/users/useraccountstatus');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(status);
  });
});

describe('registerUserTools', () => {
  it('registers ofw_get_profile and ofw_get_notifications', () => {
    const client = makeClient({});
    setup(client);
    expect(handlers.has('ofw_get_profile')).toBe(true);
    expect(handlers.has('ofw_get_notifications')).toBe(true);
  });
});
