import { McpServer } from '@modelcontextprotocol/server';
import type { OFWClient } from '../client.js';
import { jsonResponse } from './_shared.js';

export function registerUserTools(server: McpServer, client: OFWClient): void {
  server.registerTool('ofw_get_profile', {
    description: 'Get current user and co-parent profile information from OurFamilyWizard',
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v2/profiles');
    return jsonResponse(data);
  });

  server.registerTool('ofw_get_notifications', {
    description:
      'Get OurFamilyWizard dashboard summary: unread message count, upcoming events, outstanding expenses. Note: updates your last-seen status.',
    // Not read-only: this GET updates the last-seen status the co-parent can
    // see, a side effect the read tools deliberately avoid (see _shared.ts).
    // readOnlyHint:true would let a host auto-approve it without a prompt.
    // Destructive by the inverse test: nothing here restores a last-seen
    // status the co-parent has already been shown.
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async () => {
    const data = await client.request('GET', '/pub/v1/users/useraccountstatus');
    return jsonResponse(data);
  });
}
