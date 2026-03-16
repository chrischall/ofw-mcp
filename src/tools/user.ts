import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { OFWClient } from '../client.js';

export const toolDefinitions: Tool[] = [
  {
    name: 'ofw_get_profile',
    description: 'Get current user and co-parent profile information from OurFamilyWizard',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'ofw_get_notifications',
    description:
      'Get OurFamilyWizard dashboard summary: unread message count, upcoming events, outstanding expenses',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

export async function handleTool(
  name: string,
  _args: Record<string, unknown>,
  client: OFWClient
): Promise<CallToolResult> {
  switch (name) {
    case 'ofw_get_profile': {
      const data = await client.request('GET', '/pub/v2/profiles');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    case 'ofw_get_notifications': {
      const data = await client.request('GET', '/pub/v1/users/useraccountstatus');
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
