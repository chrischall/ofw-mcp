import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { OFWClient } from '../client.js';
import { jsonResponse, requestWrite, textResponse, UnconfirmedWriteError, unconfirmedWriteResponse } from './_shared.js';
import { CONFIRM_NOTE, confirmTokenParam, confirmWrite, stateRevision } from './_confirm.js';
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
  // Omitted `children` PRESERVES existing tags on PUT; an explicit [] CLEARS
  // them (verified live 2026-07-13) — so send the array whenever it's defined.
  if (a.children !== undefined) payload.children = a.children;
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
    // Untagged (nullish or empty) → undefined, so the merged PUT omits the
    // field (omission preserves; only a CALLER-supplied [] should clear).
    children: d.children?.length ? d.children.map((c) => c.userId) : undefined,
    eventParentId: d.eventParent?.userId,
    dropOffParentId: d.dropOffParent?.userId,
    pickUpParentId: d.pickUpParent?.userId,
  };
}

const SHARED = 'shared with co-parent';
const PRIVATE = 'private (only you)';

/**
 * The human-readable form of an event for a confirmation preview: the fields
 * a person checks (title, when, where, who sees it), with tagged users named
 * wherever OFW's own event detail named them. An id OFW gave no name for is
 * reported with `name: null` — never an invented one.
 */
function describeEvent(a: EventWriteArgs, names: ReadonlyMap<number, string> = new Map()): Record<string, unknown> {
  const who = (id: number) => ({ userId: id, name: names.get(id) ?? null });
  const out: Record<string, unknown> = {
    title: a.title,
    startDate: a.startDate,
    endDate: a.endDate ?? a.startDate,
    ...(a.allDay ? { allDay: true } : { startTime: a.startTime, endTime: a.endTime }),
    visibility: a.privateEvent ? PRIVATE : SHARED,
  };
  if (a.location) out.location = a.location;
  if (a.notes) out.notes = a.notes;
  if (a.children !== undefined) out.children = a.children.map((id) => who(id));
  if (a.eventParentId !== undefined) out.eventParent = who(a.eventParentId);
  if (a.dropOffParentId !== undefined) out.dropOffParent = who(a.dropOffParentId);
  if (a.pickUpParentId !== undefined) out.pickUpParent = who(a.pickUpParentId);
  return out;
}

/** userId → name for every tagged person the event detail names. */
function namesIn(d: EventDetail): Map<number, string> {
  const names = new Map<number, string>();
  for (const ref of [...(d.children ?? []), d.eventParent, d.dropOffParent, d.pickUpParent]) {
    const name = (ref as { name?: unknown } | null | undefined)?.name;
    if (ref && typeof name === 'string' && name) names.set(ref.userId, name);
  }
  return names;
}

export function registerCalendarTools(server: McpServer, client: OFWClient): void {
  // Calendar writes land on the court-visible record with no draft stage, but
  // events are reversible — 'all' mode, or 'drafts' + OFW_CALENDAR_WRITES=true.
  const allowWrites = getCalendarWritesAllowed();

  server.registerTool('ofw_list_events', {
    description: 'List OurFamilyWizard calendar events in a date range',
    annotations: { readOnlyHint: true },
    inputSchema: z.object({
      startDate: z.string().describe('Start date YYYY-MM-DD'),
      endDate: z.string().describe('End date YYYY-MM-DD'),
      detailed: z.boolean().describe('Return full event details (default false)').optional(),
    }),
  }, async (args) => {
    const variant = args.detailed ? 'detailed' : 'basic';
    const data = await client.request(
      'GET',
      `/pub/v1/calendar/${variant}?startDate=${encodeURIComponent(args.startDate)}&endDate=${encodeURIComponent(args.endDate)}`
    );
    return jsonResponse(data);
  });

  if (allowWrites) server.registerTool('ofw_create_event', {
    description: 'Create a calendar event in OurFamilyWizard. Unless privateEvent is true, the event is immediately visible to the co-parent — there is no draft stage — so a shared event is confirmed first (a private one is not). If the request fails without a definitive answer the result is EVENT_UNCONFIRMED: the event may already exist, so do NOT retry until ofw_list_events shows it did not land. ' + CONFIRM_NOTE,
    // Additive, so not destructive — but it lands on a shared calendar
    // outside this machine, which openWorldHint says to the host.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    inputSchema: z.object({
      title: z.string(),
      ...eventWriteFields,
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const { confirmToken, ...fields } = args;
    const payload = buildEventPayload(fields as EventWriteArgs);
    if (!fields.privateEvent) {
      const gate = await confirmWrite(ctx, {
        tool: 'ofw_create_event',
        action: 'ofw.event.create',
        message: 'Review and confirm this OurFamilyWizard calendar event. It is shared with the co-parent and appears on their calendar immediately.',
        target: 'event:new',
        payload,
        preview: {
          action: 'Create shared OurFamilyWizard calendar event',
          event: describeEvent(fields as EventWriteArgs),
          warning: 'Visible to the co-parent immediately; part of the court-visible record.',
        },
        confirmToken,
      });
      if (gate) return gate;
    }
    let raw: unknown;
    try {
      raw = await requestWrite(client, 'POST', '/pub/v3/events', payload);
    } catch (e) {
      if (!(e instanceof UnconfirmedWriteError)) throw e;
      return unconfirmedWriteResponse(e, {
        result: 'EVENT_UNCONFIRMED',
        what: 'create this event',
        checkWith: `ofw_list_events for ${fields.startDate} (look for "${fields.title}")`,
      });
    }
    const event = parseLenient(eventDetailSchema, raw, { label: 'ofw-mcp', context: 'POST /pub/v3/events', mode: 'strict' });
    return jsonResponse({
      note: `Event created. Use eventRecurrenceId ${event.eventRecurrenceId} as eventId for ofw_update_event/ofw_delete_event.`,
      event,
    });
  });

  if (allowWrites) server.registerTool('ofw_update_event', {
    description: 'Update an existing OurFamilyWizard calendar event. Fetches the event, applies the given changes, and writes the merged result back (OFW has no partial update). A change to an event the co-parent can see (shared before or after the change) is confirmed first; the confirmation is bound to the event exactly as read, so if it changes on OFW in between (say the co-parent edited it) the update is refused instead of overwriting their edit. ' + CONFIRM_NOTE,
    annotations: { destructiveHint: true },
    inputSchema: z.object({
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
      children: z.array(z.number()).describe('Child userIds to tag; pass [] to remove all child tags (omit to keep current tags)').optional(),
      eventParentId: eventWriteFields.eventParentId,
      dropOffParentId: eventWriteFields.dropOffParentId,
      pickUpParentId: eventWriteFields.pickUpParentId,
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const { eventId, confirmToken, ...changes } = args;
    const id = encodeURIComponent(eventId);
    // Re-read on EVERY call (phase 1 and phase 2 alike): the merge base and
    // the confirmation's revision both come from this read.
    const rawDetail = await client.request('GET', `/pub/v3/events/${id}`);
    const current = parseLenient(eventDetailSchema, rawDetail, { label: 'ofw-mcp', context: `GET /pub/v3/events/${eventId}`, mode: 'strict' });
    const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
    const base = detailToWriteArgs(current);
    const merged: EventWriteArgs = { ...base, ...defined };
    const payload = buildEventPayload(merged);
    if (current.publicFlag || !merged.privateEvent) {
      const names = namesIn(current);
      const gate = await confirmWrite(ctx, {
        tool: 'ofw_update_event',
        action: 'ofw.event.update',
        message: `Review and confirm this change to the OurFamilyWizard event "${current.title}". The co-parent sees the updated event on their calendar.`,
        target: `event:${eventId}`,
        revision: stateRevision(base),
        payload,
        preview: {
          action: 'Update OurFamilyWizard calendar event',
          eventId,
          before: describeEvent(base, names),
          after: describeEvent(merged, names),
          warning: 'The co-parent sees this change; part of the court-visible record.',
        },
        confirmToken,
      });
      if (gate) return gate;
    }
    await client.request('PUT', `/pub/v3/events/${id}`, payload);
    // PUT responses aren't documented — re-fetch the detail as authoritative state.
    const rawAfter = await client.request('GET', `/pub/v3/events/${id}`);
    const event = parseLenient(eventDetailSchema, rawAfter, { label: 'ofw-mcp', context: `GET /pub/v3/events/${eventId} (post-update)`, mode: 'strict' });
    return jsonResponse({ note: 'Event updated; returning re-fetched event state.', event });
  });

  if (allowWrites) server.registerTool('ofw_delete_event', {
    description: 'Delete an OurFamilyWizard calendar event. Reads the event first; deleting one the co-parent can see is confirmed first, with a preview of exactly which event (title, date, time) is removed, and is refused if the event changed on OFW after that preview. ' + CONFIRM_NOTE,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    inputSchema: z.object({
      eventId: z.string().describe('Event id — the `id` from ofw_list_events / eventRecurrenceId from ofw_create_event'),
      includeFuture: z.boolean().describe('For repeating events: also delete future occurrences (default false)').optional(),
      confirmToken: confirmTokenParam,
    }),
  }, async (args, ctx) => {
    const includeFuture = args.includeFuture ?? false;
    const id = encodeURIComponent(args.eventId);
    const rawDetail = await client.request('GET', `/pub/v3/events/${id}`);
    const current = parseLenient(eventDetailSchema, rawDetail, { label: 'ofw-mcp', context: `GET /pub/v3/events/${args.eventId}`, mode: 'strict' });
    if (current.publicFlag) {
      const base = detailToWriteArgs(current);
      const gate = await confirmWrite(ctx, {
        tool: 'ofw_delete_event',
        action: 'ofw.event.delete',
        message: `Review and confirm deleting the OurFamilyWizard event "${current.title}". It disappears from the co-parent's calendar.`,
        target: `event:${args.eventId}`,
        revision: stateRevision(base),
        payload: { eventId: args.eventId, includeFuture },
        preview: {
          action: 'Delete shared OurFamilyWizard calendar event',
          eventId: args.eventId,
          event: describeEvent(base, namesIn(current)),
          includeFuture,
          ...(includeFuture ? { note: 'Future occurrences of this repeating event are deleted too.' } : {}),
          warning: 'Removed from the co-parent\'s calendar.',
        },
        confirmToken: args.confirmToken,
      });
      if (gate) return gate;
    }
    await client.request('DELETE', `/pub/v3/events/${id}?includeFuture=${includeFuture}`);
    return textResponse(`Event ${args.eventId} ("${current.title}") deleted`);
  });
}
