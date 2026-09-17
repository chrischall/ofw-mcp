import { McpServer } from '@modelcontextprotocol/server';
import type { OFWClient } from '../client.js';
import { jsonResponse } from './_shared.js';

export function registerUserTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_get_profile', {
    description: 'Get current user and co-parent profile information from OurFamilyWizard',
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/profiles');
    return jsonResponse(data);
  });

  server.registerTool('ofw_get_notifications', {
    description:
      'Get OurFamilyWizard dashboard summary: unread message count, upcoming events, outstanding expenses. Note: updates your last-seen status.',
    annotations: { readOnlyHint: false },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/users/useraccountstatus');
    return jsonResponse(data);
  });
}
