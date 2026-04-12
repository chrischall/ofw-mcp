import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { OFWClient } from '../client.js';

export function registerCalendarTools(server: McpServer, client: OFWClient): void {
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
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_create_event', {
    description: 'Create a calendar event in OurFamilyWizard',
    annotations: { destructiveHint: false },
    inputSchema: {
      title: z.string(),
      startDate: z.string().describe('ISO datetime string'),
      endDate: z.string().describe('ISO datetime string'),
      allDay: z.boolean().optional(),
      location: z.string().optional(),
      reminder: z.string().describe('Reminder setting (e.g. "1 hour before")').optional(),
      privateEvent: z.boolean().optional(),
      eventFor: z.string().describe('neither | parent1 | parent2').optional(),
      dropOffParent: z.string().optional(),
      pickUpParent: z.string().optional(),
      children: z.array(z.number()).describe('Array of child IDs').optional(),
    },
  }, async (args) => {
    const data = await client.request('POST', '/pub/v1/calendar/events', args);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_update_event', {
    description: 'Update an existing OurFamilyWizard calendar event',
    annotations: { destructiveHint: false },
    inputSchema: {
      eventId: z.string(),
      title: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      allDay: z.boolean().optional(),
      location: z.string().optional(),
      reminder: z.string().optional(),
      privateEvent: z.boolean().optional(),
    },
  }, async (args) => {
    const { eventId, ...updateData } = args;
    const data = await client.request('PUT', `/pub/v1/calendar/events/${encodeURIComponent(eventId)}`, updateData);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_delete_event', {
    description: 'Delete an OurFamilyWizard calendar event',
    annotations: { destructiveHint: true },
    inputSchema: {
      eventId: z.string().describe('Event ID to delete'),
    },
  }, async (args) => {
    await client.request('DELETE', `/pub/v1/calendar/events/${encodeURIComponent(args.eventId)}`);
    return { content: [{ type: 'text' as const, text: `Event ${args.eventId} deleted` }] };
  });
}
