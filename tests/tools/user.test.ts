import { describe, it, expect, vi, afterEach } from 'vitest';
import { OFWClient } from '../../src/client.js';
import { handleTool, toolDefinitions } from '../../src/tools/user.js';

function makeClient(returnValue: unknown) {
  const c = new OFWClient();
  vi.spyOn(c, 'request').mockResolvedValue(returnValue);
  return c;
}

afterEach(() => vi.restoreAllMocks());

describe('ofw_get_profile', () => {
  it('calls /pub/v2/profiles', async () => {
    const profiles = { user: { id: 1, name: 'Chris' }, coParent: { id: 2, name: 'Jane' } };
    const client = makeClient(profiles);

    const result = await handleTool('ofw_get_profile', {}, client);

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v2/profiles');
    expect(result.content[0].text).toContain('Chris');
  });
});

describe('ofw_get_notifications', () => {
  it('calls /pub/v1/users/useraccountstatus', async () => {
    const status = { unreadMessages: 3, upcomingEvents: 1, outstandingExpenses: 2 };
    const client = makeClient(status);

    const result = await handleTool('ofw_get_notifications', {}, client);

    expect(client.request).toHaveBeenCalledWith('GET', '/pub/v1/users/useraccountstatus');
    expect(result.content[0].text).toContain('3');
  });
});

describe('toolDefinitions', () => {
  it('exports ofw_get_profile and ofw_get_notifications', () => {
    const names = toolDefinitions.map((t) => t.name);
    expect(names).toContain('ofw_get_profile');
    expect(names).toContain('ofw_get_notifications');
  });
});
