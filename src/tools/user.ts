import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OFWClient } from '../client.js';

export function registerUserTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_get_profile', {
    description: 'Get current user and co-parent profile information from OurFamilyWizard',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/profiles');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.registerTool('ofw_get_notifications', {
    description:
      'Get OurFamilyWizard dashboard summary: unread message count, upcoming events, outstanding expenses. Note: updates your last-seen status.',
    annotations: { readOnlyHint: false },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/users/useraccountstatus');
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
