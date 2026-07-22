import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { OFWClient } from '../../src/client.js';
import { registerCalendarTools } from '../../src/tools/calendar.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;

let server: McpServer;
let handlers: Map<string, ToolHandler>;

// A live-verified POST /pub/v3/events response (2026-07-10), trimmed.
const EVENT_DETAIL = {
  eventRecurrenceId: 128246904,
  eventId: 24325511,
  title: 'Dentist',
  startDate: { dateTime: '2026-07-11T09:00:00', displayDate: '7/11/2026' },
  endDate: { dateTime: '2026-07-11T09:15:00', displayDate: '7/11/2026' },
  allDay: false,
  repeating: false,
  eventParent: null,
  dropOffParent: null,
  pickUpParent: null,
  children: [],
  location: null,
  reminderMinutes: 0,
  publicFlag: false,
  notes: null,
  canEditDelete: true,
};

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

function setup(client: OFWClient) {
  server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerCalendarTools(server, client);
}

afterEach(() => vi.restoreAllMocks());

// Default write mode is now fail-safe 'none'; these tests exercise the write
// tools, so opt into 'all'. The OFW_WRITE_MODE gating describe overrides.
let originalWriteMode: string | undefined;
beforeEach(() => {
  originalWriteMode = process.env.OFW_WRITE_MODE;
  process.env.OFW_WRITE_MODE = 'all';
});
afterEach(() => {
  if (originalWriteMode === undefined) delete process.env.OFW_WRITE_MODE;
  else process.env.OFW_WRITE_MODE = originalWriteMode;
});

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
  it('posts to /pub/v3/events with a form-shaped payload', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    const result = await handler({
      title: 'Dentist',
      startDate: '2026-07-11',
      startTime: '09:00',
      endTime: '09:15',
      privateEvent: true,
    });
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/events', {
      title: 'Dentist',
      startDate: '2026-07-11',
      endDate: '2026-07-11', // defaults to startDate
      startTime: '09:00',
      endTime: '09:15',
      allDay: false,
      publicFlag: false, // privateEvent inverted
    });
    const body = JSON.parse(result.content[0].text);
    expect(body.event.eventRecurrenceId).toBe(128246904);
    expect(body.note).toContain('128246904');
  });

  it('passes optional fields through and stringifies ids/minutes', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    await handler({
      title: 'Camp drop-off',
      startDate: '2026-07-20',
      endDate: '2026-07-21',
      startTime: '08:00',
      endTime: '09:00',
      location: 'Hume Lake',
      notes: 'Pack sunscreen',
      reminderMinutes: 60,
      children: [2737713, 2737714],
      eventParentId: 111,
      dropOffParentId: 222,
      pickUpParentId: 333,
    });
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/events', expect.objectContaining({
      endDate: '2026-07-21',
      publicFlag: true,
      location: 'Hume Lake',
      notes: 'Pack sunscreen',
      reminderMinutes: '60',
      children: [2737713, 2737714],
      eventParentId: '111',
      dropOffParentId: '222',
      pickUpParentId: '333',
    }));
  });

  it('sends an explicit empty children array as-is (verified live: POST accepts [])', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    await handler({ title: 'Solo errand', startDate: '2026-07-20', allDay: true, children: [] });
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/events', expect.objectContaining({
      children: [],
    }));
  });

  it('all-day events get placeholder times like the web form', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    await handler({ title: 'Holiday', startDate: '2026-12-25', allDay: true });
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/events', expect.objectContaining({
      allDay: true,
      startTime: '01:00',
      endTime: '02:00',
    }));
  });

  it('rejects timed events without startTime/endTime', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    await expect(handler({ title: 'Dentist', startDate: '2026-07-11' }))
      .rejects.toThrow('startTime and endTime');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('throws (strict validation) when the POST response is not an event', async () => {
    const client = makeClient({ whatever: true });
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    await expect(handler({ title: 'X', startDate: '2026-07-11', allDay: true }))
      .rejects.toThrow(/Unexpected POST \/pub\/v3\/events shape from the upstream API/);
  });
});

describe('ofw_update_event', () => {
  it('fetches the event, merges changes, PUTs the full payload, and re-fetches', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(EVENT_DETAIL) // GET current
      .mockResolvedValueOnce(undefined) // PUT
      .mockResolvedValueOnce({ ...EVENT_DETAIL, title: 'Dentist (rescheduled)' }); // GET after
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    const result = await handler({ eventId: '128246904', title: 'Dentist (rescheduled)' });

    expect(spy).toHaveBeenNthCalledWith(1, 'GET', '/pub/v3/events/128246904');
    expect(spy).toHaveBeenNthCalledWith(2, 'PUT', '/pub/v3/events/128246904', {
      title: 'Dentist (rescheduled)', // the change
      startDate: '2026-07-11', // everything else carried over from the detail
      endDate: '2026-07-11',
      startTime: '09:00',
      endTime: '09:15',
      allDay: false,
      publicFlag: false,
      reminderMinutes: '0',
    });
    expect(spy).toHaveBeenNthCalledWith(3, 'GET', '/pub/v3/events/128246904');
    const body = JSON.parse(result.content[0].text);
    expect(body.event.title).toBe('Dentist (rescheduled)');
  });

  it('carries over populated optional fields from the existing event', async () => {
    const populated = {
      ...EVENT_DETAIL,
      location: 'Office',
      notes: 'Bring forms',
      reminderMinutes: 30,
      publicFlag: true,
      children: [{ userId: 2737713, name: 'Paige' }],
      eventParent: { userId: 111 },
      dropOffParent: { userId: 222 },
      pickUpParent: { userId: 333 },
    };
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(populated)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(populated);
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    await handler({ eventId: '128246904', startTime: '10:00', endTime: '10:30' });
    expect(spy).toHaveBeenNthCalledWith(2, 'PUT', '/pub/v3/events/128246904', expect.objectContaining({
      startTime: '10:00',
      endTime: '10:30',
      location: 'Office',
      notes: 'Bring forms',
      reminderMinutes: '30',
      publicFlag: true,
      children: [2737713],
      eventParentId: '111',
      dropOffParentId: '222',
      pickUpParentId: '333',
    }));
  });

  it('clears all child tags when the caller passes children: []', async () => {
    // Verified live 2026-07-13: PUT with children omitted PRESERVES existing
    // tags; PUT with an explicit children: [] CLEARS them. So [] must survive
    // into the payload rather than being dropped as falsy-ish.
    const tagged = { ...EVENT_DETAIL, children: [{ userId: 2737713, name: 'Paige' }] };
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(tagged)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...tagged, children: [] });
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    await handler({ eventId: '128246904', children: [] });
    expect(spy).toHaveBeenNthCalledWith(2, 'PUT', '/pub/v3/events/128246904', expect.objectContaining({
      children: [],
    }));
  });

  it('ignores explicitly-undefined changes instead of clobbering fetched values', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(EVENT_DETAIL)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    await handler({ eventId: '128246904', title: undefined, notes: 'Added a note' });
    expect(spy).toHaveBeenNthCalledWith(2, 'PUT', '/pub/v3/events/128246904', expect.objectContaining({
      title: 'Dentist', // preserved despite title: undefined in args
      notes: 'Added a note',
    }));
  });

  it('handles date-only dateTimes and null children on all-day events', async () => {
    const allDayDetail = {
      ...EVENT_DETAIL,
      allDay: true,
      startDate: { dateTime: '2026-12-25' }, // no time component
      endDate: { dateTime: '2026-12-25' },
      children: null,
      reminderMinutes: null,
    };
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(allDayDetail)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(allDayDetail);
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    await handler({ eventId: '77', title: 'Christmas' });
    expect(spy).toHaveBeenNthCalledWith(2, 'PUT', '/pub/v3/events/77', expect.objectContaining({
      allDay: true,
      startTime: '01:00', // placeholder fallback when the detail has no clock
      endTime: '02:00',
    }));
  });

  it('throws before PUTting when the fetched event fails validation', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValueOnce({ nope: true });
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    await expect(handler({ eventId: '5', title: 'X' })).rejects.toThrow(/Unexpected GET \/pub\/v3\/events\/5 shape from the upstream API/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('ofw_delete_event', () => {
  it('deletes /pub/v3/events/{id} with includeFuture=false by default', async () => {
    const client = makeClient(undefined);
    setup(client);
    const handler = handlers.get('ofw_delete_event')!;
    const result = await handler({ eventId: '128246904' });
    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v3/events/128246904?includeFuture=false');
    expect(result.content[0].text).toContain('128246904');
  });

  it('passes includeFuture=true for repeating events', async () => {
    const client = makeClient(undefined);
    setup(client);
    const handler = handlers.get('ofw_delete_event')!;
    await handler({ eventId: '55', includeFuture: true });
    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v3/events/55?includeFuture=true');
  });
});

describe('OFW_WRITE_MODE gating', () => {
  let originalMode: string | undefined;
  let originalFlag: string | undefined;
  beforeEach(() => {
    originalMode = process.env.OFW_WRITE_MODE;
    originalFlag = process.env.OFW_CALENDAR_WRITES;
    delete process.env.OFW_CALENDAR_WRITES;
  });
  afterEach(() => {
    if (originalMode === undefined) delete process.env.OFW_WRITE_MODE;
    else process.env.OFW_WRITE_MODE = originalMode;
    if (originalFlag === undefined) delete process.env.OFW_CALENDAR_WRITES;
    else process.env.OFW_CALENDAR_WRITES = originalFlag;
  });

  it('calendar writes are absent below mode "all" without the opt-in flag', () => {
    for (const mode of ['none', 'drafts']) {
      process.env.OFW_WRITE_MODE = mode;
      setup(makeClient({}));
      expect(handlers.has('ofw_create_event')).toBe(false);
      expect(handlers.has('ofw_update_event')).toBe(false);
      expect(handlers.has('ofw_delete_event')).toBe(false);
      expect(handlers.has('ofw_list_events')).toBe(true); // reads unaffected
    }
  });

  it('calendar writes register in mode "all"', () => {
    process.env.OFW_WRITE_MODE = 'all';
    setup(makeClient({}));
    expect(handlers.has('ofw_create_event')).toBe(true);
    expect(handlers.has('ofw_update_event')).toBe(true);
    expect(handlers.has('ofw_delete_event')).toBe(true);
  });

  it('OFW_CALENDAR_WRITES=true registers calendar writes in mode "drafts"', () => {
    process.env.OFW_WRITE_MODE = 'drafts';
    process.env.OFW_CALENDAR_WRITES = 'true';
    setup(makeClient({}));
    expect(handlers.has('ofw_create_event')).toBe(true);
    expect(handlers.has('ofw_update_event')).toBe(true);
    expect(handlers.has('ofw_delete_event')).toBe(true);
  });

  it('OFW_CALENDAR_WRITES does not override mode "none"', () => {
    process.env.OFW_WRITE_MODE = 'none';
    process.env.OFW_CALENDAR_WRITES = 'true';
    setup(makeClient({}));
    expect(handlers.has('ofw_create_event')).toBe(false);
    expect(handlers.has('ofw_update_event')).toBe(false);
    expect(handlers.has('ofw_delete_event')).toBe(false);
  });
});
