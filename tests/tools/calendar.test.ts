import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerCalendarTools } from '../../src/tools/calendar.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let server: McpServer;
let handlers: Map<string, ToolHandler>;

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function setup(client: OFWClient) {
  server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  const origRegister = server.registerTool.bind(server);
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerCalendarTools(server, client);
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_events', () => {
  it('calls calendar/basic by default', async () => {
    const events = [{ id: 1, title: 'School pickup' }];
    const client = makeClient(events);
    setup(client);
    const handler = handlers.get('ofw_list_events')!;
    const result = await handler({ startDate: '2026-03-01', endDate: '2026-03-31' });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/calendar/basic?startDate=2026-03-01&endDate=2026-03-31'
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(JSON.parse(result.content[0].text)).toEqual(events);
  });

  it('calls calendar/detailed when detailed=true', async () => {
    const client = makeClient([]);
    setup(client);
    const handler = handlers.get('ofw_list_events')!;
    await handler({ startDate: '2026-03-01', endDate: '2026-03-31', detailed: true });
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/calendar/detailed?startDate=2026-03-01&endDate=2026-03-31'
    );
  });
});

describe('ofw_create_event', () => {
  it('posts to calendar/events with required fields', async () => {
    const client = makeClient({ id: 55 });
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    const result = await handler({
      title: 'Doctor appointment',
      startDate: '2026-03-20T10:00:00',
      endDate: '2026-03-20T11:00:00',
    });
    expect(client.request).toHaveBeenCalledWith(
      'POST',
      '/pub/v1/calendar/events',
      expect.objectContaining({ title: 'Doctor appointment' })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('ofw_update_event', () => {
  it('puts to calendar/events/{id}', async () => {
    const client = makeClient({ id: 55 });
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    const result = await handler({ eventId: '55', title: 'Updated' });
    expect(client.request).toHaveBeenCalledWith(
      'PUT',
      '/pub/v1/calendar/events/55',
      expect.objectContaining({ title: 'Updated' })
    );
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
  });
});

describe('ofw_delete_event', () => {
  it('deletes calendar/events/{id}', async () => {
    const client = makeClient({});
    setup(client);
    const handler = handlers.get('ofw_delete_event')!;
    const result = await handler({ eventId: '55' });
    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v1/calendar/events/55');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('55');
  });
});

describe('registerCalendarTools', () => {
  it('registers 4 calendar tools', () => {
    const client = makeClient({});
    setup(client);
    expect(handlers.size).toBe(4);
    expect(handlers.has('ofw_list_events')).toBe(true);
    expect(handlers.has('ofw_create_event')).toBe(true);
    expect(handlers.has('ofw_update_event')).toBe(true);
    expect(handlers.has('ofw_delete_event')).toBe(true);
  });
});
