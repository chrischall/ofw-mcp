import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { jsonResponse, textResponse } from './_shared.js';
import { getCalendarWritesAllowed } from '../config.js';
import { parseLenient } from '@chrischall/mcp-utils';

// OFW's real event-write API (reverse-engineered from the web app bundle):
//   POST   /pub/v3/events                       create — 201 with the full event
//   GET    /pub/v3/events/{eventRecurrenceId}   detail
//   PUT    /pub/v3/events/{eventRecurrenceId}   update — full payload, not a patch
//   DELETE /pub/v3/events/{eventRecurrenceId}?includeFuture=<bool>
// The id in every URL is `eventRecurrenceId` — the same value calendar
// listings expose as `id`. (`eventId` in the response is a different,
// internal identifier; never put it in a URL.)
// Payload gotchas: dates are `YYYY-MM-DD` with separate `HH:mm` times;
// privacy is `publicFlag` (true = shared with co-parent); parent ids must be
// OMITTED when unset — the web form's "0" placeholders draw a 409
// "Must be a parent" from the API.

const ofwDate = z.looseObject({ dateTime: z.string() });
const userRef = z.looseObject({ userId: z.number() });
const eventDetailSchema = z.looseObject({
  eventRecurrenceId: z.number(),
  title: z.string(),
  allDay: z.boolean(),
  publicFlag: z.boolean(),
  startDate: ofwDate,
  endDate: ofwDate,
  location: z.string().nullish(),
  notes: z.string().nullish(),
  reminderMinutes: z.number().nullish(),
  children: z.array(userRef).nullish(),
  eventParent: userRef.nullish(),
  dropOffParent: userRef.nullish(),
  pickUpParent: userRef.nullish(),
});
type EventDetail = z.output<typeof eventDetailSchema>;

const eventWriteFields = {
  startDate: z.string().describe('Start date YYYY-MM-DD'),
  endDate: z.string().describe('End date YYYY-MM-DD (default: startDate)').optional(),
  startTime: z.string().describe('Start time HH:mm, 24-hour (required unless allDay)').optional(),
  endTime: z.string().describe('End time HH:mm, 24-hour (required unless allDay)').optional(),
  allDay: z.boolean().optional(),
  privateEvent: z.boolean().describe('true = visible only to you; default false = shared with co-parent').optional(),
  location: z.string().optional(),
  notes: z.string().optional(),
  reminderMinutes: z.number().int().min(0).optional(),
  children: z.array(z.number()).describe('Child userIds to tag (see ofw_get_profile)').optional(),
  eventParentId: z.number().describe("userId of the parent the event is 'for'").optional(),
  dropOffParentId: z.number().describe('userId of the drop-off parent').optional(),
  pickUpParentId: z.number().describe('userId of the pick-up parent').optional(),
};

interface EventWriteArgs {
  title: string;
  startDate: string;
  endDate?: string;
  startTime?: string;
  endTime?: string;
  allDay?: boolean;
  privateEvent?: boolean;
  location?: string;
  notes?: string;
  reminderMinutes?: number;
  children?: number[];
  eventParentId?: number;
  dropOffParentId?: number;
  pickUpParentId?: number;
}

function buildEventPayload(a: EventWriteArgs): Record<string, unknown> {
  const allDay = a.allDay ?? false;
  if (!allDay && (!a.startTime || !a.endTime)) {
    throw new Error('startTime and endTime (HH:mm) are required unless allDay is true');
  }
  const payload: Record<string, unknown> = {
    title: a.title,
    startDate: a.startDate,
    endDate: a.endDate ?? a.startDate,
    // The web form always sends times; for all-day events it uses 01:00/02:00
    // placeholders that OFW ignores.
    startTime: a.startTime ?? '01:00',
    endTime: a.endTime ?? '02:00',
    allDay,
    publicFlag: !(a.privateEvent ?? false),
  };
  if (a.location) payload.location = a.location;
  if (a.notes) payload.notes = a.notes;
  if (a.reminderMinutes !== undefined) payload.reminderMinutes = String(a.reminderMinutes);
  if (a.children?.length) payload.children = a.children;
  if (a.eventParentId !== undefined) payload.eventParentId = String(a.eventParentId);
  if (a.dropOffParentId !== undefined) payload.dropOffParentId = String(a.dropOffParentId);
  if (a.pickUpParentId !== undefined) payload.pickUpParentId = String(a.pickUpParentId);
  return payload;
}

// Map a detail response back onto write-args so ofw_update_event can send the
// full payload OFW's PUT expects while the caller only names the changes.
function detailToWriteArgs(d: EventDetail): EventWriteArgs {
  const [startDate, startClock] = d.startDate.dateTime.split('T');
  const [endDate, endClock] = d.endDate.dateTime.split('T');
  return {
    title: d.title,
    startDate,
    endDate,
    startTime: (startClock ?? '01:00:00').slice(0, 5),
    endTime: (endClock ?? '02:00:00').slice(0, 5),
    allDay: d.allDay,
    privateEvent: !d.publicFlag,
    location: d.location ?? undefined,
    notes: d.notes ?? undefined,
    reminderMinutes: d.reminderMinutes ?? undefined,
    children: d.children?.map((c) => c.userId),
    eventParentId: d.eventParent?.userId,
    dropOffParentId: d.dropOffParent?.userId,
    pickUpParentId: d.pickUpParent?.userId,
  };
}

export function registerCalendarTools(server: McpServer, client: OFWClient): void {
  // Calendar writes land on the court-visible record with no draft stage, but
  // events are reversible — 'all' mode, or 'drafts' + OFW_CALENDAR_WRITES=true.
  const allowWrites = getCalendarWritesAllowed();

  server.registerTool('ofw_list_events', {
    description: 'List OurFamilyWizard calendar events in a date range',
    annotations: { readOnlyHint: true },
    inputSchema: {
      startDate: z.string().describe('Start date YYYY-MM-DD'),
      endDate: z.string().describe('End date YYYY-MM-DD'),
      detailed: z.boolean().describe('Return full event details (default false)').optional(),
    },
  }, async (args) => {
    const variant = args.detailed ? 'detailed' : 'basic';
    const data = await client.request(
      'GET',
      `/pub/v1/calendar/${variant}?startDate=${encodeURIComponent(args.startDate)}&endDate=${encodeURIComponent(args.endDate)}`
    );
    return jsonResponse(data);
  });

  if (allowWrites) server.registerTool('ofw_create_event', {
    description: 'Create a calendar event in OurFamilyWizard. Unless privateEvent is true, the event is immediately visible to the co-parent — there is no draft stage.',
    annotations: { destructiveHint: false },
    inputSchema: {
      title: z.string(),
      ...eventWriteFields,
    },
  }, async (args) => {
    const raw = await client.request('POST', '/pub/v3/events', buildEventPayload(args as EventWriteArgs));
    const event = parseLenient(eventDetailSchema, raw, { label: 'ofw-mcp', context: 'POST /pub/v3/events', mode: 'strict' });
    return jsonResponse({
      note: `Event created. Use eventRecurrenceId ${event.eventRecurrenceId} as eventId for ofw_update_event/ofw_delete_event.`,
      event,
    });
  });

  if (allowWrites) server.registerTool('ofw_update_event', {
    description: 'Update an existing OurFamilyWizard calendar event. Fetches the event, applies the given changes, and writes the merged result back (OFW has no partial update).',
    annotations: { destructiveHint: true },
    inputSchema: {
      eventId: z.string().describe('Event id — the `id` from ofw_list_events / eventRecurrenceId from ofw_create_event'),
      title: z.string().optional(),
      startDate: eventWriteFields.startDate.optional(),
      endDate: eventWriteFields.endDate,
      startTime: eventWriteFields.startTime,
      endTime: eventWriteFields.endTime,
      allDay: eventWriteFields.allDay,
      privateEvent: eventWriteFields.privateEvent,
      location: eventWriteFields.location,
      notes: eventWriteFields.notes,
      reminderMinutes: eventWriteFields.reminderMinutes,
      children: eventWriteFields.children,
      eventParentId: eventWriteFields.eventParentId,
      dropOffParentId: eventWriteFields.dropOffParentId,
      pickUpParentId: eventWriteFields.pickUpParentId,
    },
  }, async (args) => {
    const { eventId, ...changes } = args;
    const id = encodeURIComponent(eventId);
    const rawDetail = await client.request('GET', `/pub/v3/events/${id}`);
    const current = parseLenient(eventDetailSchema, rawDetail, { label: 'ofw-mcp', context: `GET /pub/v3/events/${eventId}`, mode: 'strict' });
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    const merged: EventWriteArgs = { ...detailToWriteArgs(current), ...defined };
    await client.request('PUT', `/pub/v3/events/${id}`, buildEventPayload(merged));
    // PUT responses aren't documented — re-fetch the detail as authoritative state.
    const rawAfter = await client.request('GET', `/pub/v3/events/${id}`);
    const event = parseLenient(eventDetailSchema, rawAfter, { label: 'ofw-mcp', context: `GET /pub/v3/events/${eventId} (post-update)`, mode: 'strict' });
    return jsonResponse({ note: 'Event updated; returning re-fetched event state.', event });
  });

  if (allowWrites) server.registerTool('ofw_delete_event', {
    description: 'Delete an OurFamilyWizard calendar event',
    annotations: { destructiveHint: true },
    inputSchema: {
      eventId: z.string().describe('Event id — the `id` from ofw_list_events / eventRecurrenceId from ofw_create_event'),
      includeFuture: z.boolean().describe('For repeating events: also delete future occurrences (default false)').optional(),
    },
  }, async (args) => {
    const includeFuture = args.includeFuture ?? false;
    await client.request('DELETE', `/pub/v3/events/${encodeURIComponent(args.eventId)}?includeFuture=${includeFuture}`);
    return textResponse(`Event ${args.eventId} deleted`);
  });
}
