import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_list_events',
    description: 'List OurFamilyWizard calendar events in a date range',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'Start date YYYY-MM-DD' },
        endDate: { type: 'string', description: 'End date YYYY-MM-DD' },
        detailed: { type: 'boolean', description: 'Return full event details (default false)' },
      },
      required: ['startDate', 'endDate'],
    },
  },
  {
    name: 'ofw_create_event',
    description: 'Create a calendar event in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        startDate: { type: 'string', description: 'ISO datetime string' },
        endDate: { type: 'string', description: 'ISO datetime string' },
        allDay: { type: 'boolean' },
        location: { type: 'string' },
        reminder: { type: 'string', description: 'Reminder setting (e.g. "1 hour before")' },
        privateEvent: { type: 'boolean' },
        eventFor: { type: 'string', description: 'neither | parent1 | parent2' },
        dropOffParent: { type: 'string' },
        pickUpParent: { type: 'string' },
        children: { type: 'array', items: { type: 'number' }, description: 'Array of child IDs' },
      },
      required: ['title', 'startDate', 'endDate'],
    },
  },
  {
    name: 'ofw_update_event',
    description: 'Update an existing OurFamilyWizard calendar event',
    annotations: { destructiveHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        eventId: { type: 'string' },
        title: { type: 'string' },
        startDate: { type: 'string' },
        endDate: { type: 'string' },
        allDay: { type: 'boolean' },
        location: { type: 'string' },
        reminder: { type: 'string' },
        privateEvent: { type: 'boolean' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'ofw_delete_event',
    description: 'Delete an OurFamilyWizard calendar event',
    annotations: { destructiveHint: true },
    inputSchema: {
      type: 'object',
      properties: { eventId: { type: 'string', description: 'Event ID to delete' } },
      required: ['eventId'],
    },
  },
];

export async function handleTool(
  name: string,
  args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_list_events': {
      const { startDate, endDate, detailed = false } = args as {
        startDate: string;
        endDate: string;
        detailed?: boolean;
      };
      const variant = detailed ? 'detailed' : 'basic';
      const data = await client.request(
        'GET',
        `/pub/v1/calendar/${variant}?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
      );
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_create_event': {
      // Field names are best-guess; confirm via DevTools capture and update if needed (see pre-task note)
      const data = await client.request('POST', '/pub/v1/calendar/events', args);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_update_event': {
      const { eventId, ...updateData } = args as { eventId: string } & Record<string, unknown>;
      const data = await client.request('PUT', `/pub/v1/calendar/events/${encodeURIComponent(eventId)}`, updateData);
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_delete_event': {
      const { eventId } = args as { eventId: string };
      await client.request('DELETE', `/pub/v1/calendar/events/${encodeURIComponent(eventId)}`);
      return { content: [{ type: 'text', text: `Event ${eventId} deleted` }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
