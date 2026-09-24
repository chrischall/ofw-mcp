import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { z } from 'zod';
import { registerCalendarTools } from '../../src/tools/calendar.js';
import { CAN_ASK_CTX, NO_ELICIT_CTX, callConfirmed, callPreview, type GatedHandler } from './_confirm-helpers.js';

type ToolHandler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean; resultType?: string }>;

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
    await callConfirmed(handler as GatedHandler, {
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
    await callConfirmed(handler as GatedHandler, { title: 'Solo errand', startDate: '2026-07-20', allDay: true, children: [] });
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/events', expect.objectContaining({
      children: [],
    }));
  });

  it('all-day events get placeholder times like the web form', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const handler = handlers.get('ofw_create_event')!;
    await callConfirmed(handler as GatedHandler, { title: 'Holiday', startDate: '2026-12-25', allDay: true });
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
    await expect(callConfirmed(handler as GatedHandler, { title: 'X', startDate: '2026-07-11', allDay: true }))
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
      .mockResolvedValueOnce(populated) // phase 1 (preview) read
      .mockResolvedValueOnce(populated) // phase 2 re-read
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(populated);
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    // A shared event: the change reaches the co-parent's calendar, so it is
    // confirmed first.
    await callConfirmed(handler as GatedHandler, { eventId: '128246904', startTime: '10:00', endTime: '10:30' });
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
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce(EVENT_DETAIL).mockResolvedValueOnce(undefined);
    setup(client);
    const handler = handlers.get('ofw_delete_event')!;
    const result = await handler({ eventId: '128246904' });
    expect(client.request).toHaveBeenNthCalledWith(1, 'GET', '/pub/v3/events/128246904');
    expect(client.request).toHaveBeenNthCalledWith(2, 'DELETE', '/pub/v3/events/128246904?includeFuture=false');
    expect(result.content[0].text).toContain('128246904');
  });

  it('passes includeFuture=true for repeating events', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockResolvedValueOnce(EVENT_DETAIL).mockResolvedValueOnce(undefined);
    setup(client);
    const handler = handlers.get('ofw_delete_event')!;
    await handler({ eventId: '55', includeFuture: true });
    expect(client.request).toHaveBeenCalledWith('DELETE', '/pub/v3/events/55?includeFuture=true');
  });
});

const SHARED_EVENT = {
  ...EVENT_DETAIL,
  title: 'Pickup swap',
  publicFlag: true,
  location: 'School',
  children: [{ userId: 2737713, name: 'Child A' }],
};

describe('calendar writes — confirmation gate (SEC-2)', () => {
  it('create: a SHARED event previews title/date/time/visibility and posts nothing', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const preview = await callPreview(handlers.get('ofw_create_event')! as GatedHandler, {
      title: 'Pickup swap', startDate: '2026-07-20', startTime: '15:00', endTime: '15:30', location: 'School',
    });
    expect(client.request).not.toHaveBeenCalled();
    expect(preview.preview).toMatchObject({
      event: { title: 'Pickup swap', startDate: '2026-07-20', startTime: '15:00', endTime: '15:30', location: 'School', visibility: 'shared with co-parent' },
    });
  });

  it('create: a PRIVATE event is not gated (the co-parent never sees it)', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    await handlers.get('ofw_create_event')!({ title: 'Dentist', startDate: '2026-07-11', startTime: '09:00', endTime: '09:15', privateEvent: true }, NO_ELICIT_CTX);
    expect(client.request).toHaveBeenCalledWith('POST', '/pub/v3/events', expect.anything());
  });

  it('create: a client that can be prompted gets the real prompt', async () => {
    const client = makeClient(EVENT_DETAIL);
    setup(client);
    const result = await handlers.get('ofw_create_event')!({ title: 'X', startDate: '2026-07-11', allDay: true }, CAN_ASK_CTX);
    expect(result.resultType).toBe('input_required');
    expect(client.request).not.toHaveBeenCalled();
  });

  it('update: a shared event previews before/after with names, and no PUT happens on phase 1', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(SHARED_EVENT);
    setup(client);
    const preview = await callPreview(handlers.get('ofw_update_event')! as GatedHandler, { eventId: '128246904', startTime: '16:00', endTime: '16:30' });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['GET']);
    expect(preview.preview).toMatchObject({
      before: { title: 'Pickup swap', startTime: '09:00', visibility: 'shared with co-parent', children: [{ userId: 2737713, name: 'Child A' }] },
      after: { title: 'Pickup swap', startTime: '16:00', endTime: '16:30' },
    });
  });

  it('update: an event the co-parent edited between preview and confirmation is refused — no PUT', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(SHARED_EVENT)
      .mockResolvedValueOnce({ ...SHARED_EVENT, notes: 'Co-parent: I will be late' });
    setup(client);
    const handler = handlers.get('ofw_update_event')!;
    const args = { eventId: '128246904', title: 'Pickup swap (moved)' };
    const { confirmToken } = await callPreview(handler as GatedHandler, args);
    const result = await handler({ ...args, confirmToken }, NO_ELICIT_CTX);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'DRAFT_CHANGED', dispatched: false });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['GET', 'GET']);
  });

  it('update: making a private event shared is gated', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(EVENT_DETAIL);
    setup(client);
    const preview = await callPreview(handlers.get('ofw_update_event')! as GatedHandler, { eventId: '1', privateEvent: false });
    expect(preview.preview).toMatchObject({ after: { visibility: 'shared with co-parent' } });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['GET']);
  });

  it('delete: a shared event previews what is removed and deletes nothing on phase 1', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request').mockResolvedValue(SHARED_EVENT);
    setup(client);
    const preview = await callPreview(handlers.get('ofw_delete_event')! as GatedHandler, { eventId: '128246904', includeFuture: true });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['GET']);
    expect(preview.preview).toMatchObject({ event: { title: 'Pickup swap', startDate: '2026-07-11' }, includeFuture: true });
  });

  it('delete: phase 2 against an event that changed since the preview is refused', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(SHARED_EVENT)
      .mockResolvedValueOnce({ ...SHARED_EVENT, title: 'Pickup swap — CONFIRMED by co-parent' });
    setup(client);
    const handler = handlers.get('ofw_delete_event')!;
    const { confirmToken } = await callPreview(handler as GatedHandler, { eventId: '9' });
    const result = await handler({ eventId: '9', confirmToken }, NO_ELICIT_CTX);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: 'DRAFT_CHANGED', dispatched: false });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['GET', 'GET']);
  });

  it('delete: phase 2 with the token deletes exactly once', async () => {
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(SHARED_EVENT)
      .mockResolvedValueOnce(SHARED_EVENT)
      .mockResolvedValueOnce(undefined);
    setup(client);
    const result = await callConfirmed(handlers.get('ofw_delete_event')! as GatedHandler, { eventId: '9' }, { clearMocks: false });
    expect(spy.mock.calls.map((c) => c[0])).toEqual(['GET', 'GET', 'DELETE']);
    expect(result.content[0].text).toContain('deleted');
  });

  it('declares confirmToken on every calendar write and does not advertise create as harmless', () => {
    const s = new McpServer({ name: 'test', version: '0.0.0' });
    const configs = new Map<string, { annotations?: Record<string, unknown>; inputSchema?: z.ZodObject; description: string }>();
    vi.spyOn(s, 'registerTool').mockImplementation((name: string, config: unknown) => {
      configs.set(name, config as { annotations?: Record<string, unknown>; inputSchema?: z.ZodObject; description: string });
      return undefined as never;
    });
    registerCalendarTools(s, new OFWClient());
    for (const name of ['ofw_create_event', 'ofw_update_event', 'ofw_delete_event']) {
      expect(configs.get(name)!.inputSchema!.shape).toHaveProperty('confirmToken');
      expect(configs.get(name)!.description).toMatch(/MCP_CONFIRM_MODE/);
    }
    expect(configs.get('ofw_create_event')!.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });
});

describe('ofw_create_event — unconfirmed outcome (BUG-2)', () => {
  it('a POST that times out returns EVENT_UNCONFIRMED telling the caller NOT to retry', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API request timed out after 30000ms: POST /pub/v3/events'));
    setup(client);
    const result = await handlers.get('ofw_create_event')!({ title: 'Dentist', startDate: '2026-07-11', allDay: true, privateEvent: true });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.result).toBe('EVENT_UNCONFIRMED');
    expect(parsed.remedy).toMatch(/ofw_list_events/);
  });

  it('a definitive 409 rejection stays a plain error', async () => {
    const client = new OFWClient();
    vi.spyOn(client, 'request').mockRejectedValue(new Error('OFW API error: 409 Conflict for POST /pub/v3/events'));
    setup(client);
    await expect(handlers.get('ofw_create_event')!({ title: 'D', startDate: '2026-07-11', allDay: true, privateEvent: true }))
      .rejects.toThrow(/409/);
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
