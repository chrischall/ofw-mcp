import { describe, it, expect, vi, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
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


describe('ofw_get_notifications annotations', () => {
  it('is not advertised as read-only, because the call updates the co-parent-visible last-seen status', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { annotations?: Record<string, unknown> }>();
    vi.spyOn(server, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { annotations?: Record<string, unknown> });
      return undefined as never;
    });
    registerUserTools(server, new OFWClient());

    expect(configs.get('ofw_get_notifications')?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
    });
    expect(configs.get('ofw_get_profile')?.annotations).toMatchObject({ readOnlyHint: true });
  });
});
