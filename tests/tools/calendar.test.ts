import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/calendar.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_list_events', () => {
  it('calls calendar/basic by default', async () => {
    const events = [{ id: 1, title: 'School pickup' }];
    const client = makeClient(events);
    const result = await handleTool('ofw_list_events', { startDate: '2026-03-01', endDate: '2026-03-31' }, client);
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
    await handleTool('ofw_list_events', {
      startDate: '2026-03-01',
      endDate: '2026-03-31',
      detailed: true,
    }, client);
    expect(client.request).toHaveBeenCalledWith(
      'GET',
      '/pub/v1/calendar/detailed?startDate=2026-03-01&endDate=2026-03-31'
    );
  });
});

describe('ofw_create_event', () => {
  it('posts to calendar/events with required fields', async () => {
    const client = makeClient({ id: 55 });
    const result = await handleTool('ofw_create_event', {
      title: 'Doctor appointment',
      startDate: '2026-03-20T10:00:00',
      endDate: '2026-03-20T11:00:00',
    }, client);
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
    const result = await handleTool('ofw_update_event', { eventId: '55', title: 'Updated' }, client);
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
    const result = await handleTool('ofw_delete_event', { eventId: '55' }, client);
    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v1/calendar/events/55');
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('55');
  });
});

describe('toolDefinitions', () => {
  it('exports 4 calendar tools', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toHaveLength(4);
    expect(names).toContain('ofw_list_events');
    expect(names).toContain('ofw_create_event');
    expect(names).toContain('ofw_update_event');
    expect(names).toContain('ofw_delete_event');
  });
});

describe('unknown tool', () => {
  it('throws on unknown tool name', async () => {
    const client = makeClient({});
    await expect(handleTool('ofw_unknown', {}, client)).rejects.toThrow('Unknown tool: ofw_unknown');
  });
});
