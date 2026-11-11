import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { OFWClient } from '../../src/client.js';
import { registerMessageTools } from '../../src/tools/messages.js';
import { OFWCache } from '../../src/cache/node.js';
import { NodeAttachmentIO } from '../../src/tools/attachments.js';
import type { CacheStore } from '../../src/cache/store.js';
import { callConfirmed, callPreview } from './_confirm-helpers.js';

type ToolHandler = (args: Record<string, unknown>, ctx?: unknown) => Promise<{
  content: Array<{ type: string; text: string }>; isError?: boolean;
}>;

let cache: OFWCache;
let handlers: Map<string, ToolHandler>;

function setup(client: OFWClient) {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  handlers = new Map();
  vi.spyOn(server, 'registerTool').mockImplementation((name: string, _config: unknown, cb: unknown) => {
    handlers.set(name, cb as ToolHandler);
    return undefined as never;
  });
  registerMessageTools(server, client, (): CacheStore => cache, new NodeAttachmentIO());
}

beforeEach(() => { cache = OFWCache.open(':memory:'); });
afterEach(() => { cache.close(); vi.restoreAllMocks(); });

const MD = '## Plan\n**Friday** pickup:\n1. school\n1. cleats';
const PLAIN = 'Plan\nFriday pickup:\n1. school\n2. cleats';

/** POST → id, then the detail GET echoing `body`. */
function postMocks(client: OFWClient, id: number, body: string) {
  return vi.spyOn(client, 'request')
    .mockResolvedValueOnce({ entityId: id })
    .mockResolvedValueOnce({
      id, subject: 'S', body, date: { dateTime: '2026-11-11T12:00:00' }, from: { name: 'Me' }, recipients: [],
    });
}

const postedBody = (spy: ReturnType<typeof vi.spyOn>) =>
  (spy.mock.calls.find((c) => c[0] === 'POST')![2] as { body: string }).body;

describe('ofw_save_draft body conversion', () => {
  it('posts the plain-text conversion and reports what changed', async () => {
    const client = new OFWClient();
    const spy = postMocks(client, 42, PLAIN);
    setup(client);

    const res = await handlers.get('ofw_save_draft')!({ subject: 'S', body: MD });
    const text = res.content[0].text;

    expect(postedBody(spy)).toBe(PLAIN);
    // The landed-check compares against what was POSTED, so no false warning.
    expect(text).not.toContain('WARNING');
    expect(text).toContain('NOTE: the body was converted from Markdown to plain text');
    const json = JSON.parse(text.slice(text.indexOf('{')));
    expect(json.bodyConversion).toEqual({
      changes: ['headings', 'bold/italic', 'list numbering'],
      note: expect.stringContaining('bodyFormat:"plain"'),
    });
  });

  it('bodyFormat:"plain" posts the body exactly as written', async () => {
    const client = new OFWClient();
    const spy = postMocks(client, 42, MD);
    setup(client);

    const res = await handlers.get('ofw_save_draft')!({ subject: 'S', body: MD, bodyFormat: 'plain' });

    expect(postedBody(spy)).toBe(MD);
    expect(res.content[0].text).not.toContain('bodyConversion');
  });

  it('a body with nothing to convert carries no conversion note', async () => {
    const client = new OFWClient();
    const spy = postMocks(client, 42, PLAIN);
    setup(client);

    const res = await handlers.get('ofw_save_draft')!({ subject: 'S', body: PLAIN });

    expect(postedBody(spy)).toBe(PLAIN);
    expect(res.content[0].text).not.toContain('bodyConversion');
    expect(res.content[0].text).not.toContain('converted from Markdown');
  });
});

describe('ofw_send_message body conversion', () => {
  it('shows the CONVERTED body in the preview the human approves, and sends exactly that', async () => {
    const client = new OFWClient();
    const spy = postMocks(client, 300, PLAIN);
    setup(client);

    const phase1 = await callPreview(handlers.get('ofw_send_message')!, { subject: 'S', body: MD, recipientIds: [1] });
    expect(phase1.preview.body).toBe(PLAIN);
    // One shape for the field everywhere it appears: preview, send result, save result.
    expect(phase1.preview.bodyConversion).toEqual({
      changes: ['headings', 'bold/italic', 'list numbering'],
      note: expect.stringContaining('bodyFormat:"plain"'),
    });

    const res = await callConfirmed(handlers.get('ofw_send_message')!, { subject: 'S', body: MD, recipientIds: [1] });
    const text = res.content[0].text;
    expect(postedBody(spy)).toBe(PLAIN);
    expect(text).not.toContain('WARNING');
    expect(text).toContain('NOTE: the body was converted from Markdown to plain text');
    expect(JSON.parse(text.slice(text.indexOf('{'))).bodyConversion).toEqual(phase1.preview.bodyConversion);
  });

  it('bodyFormat:"plain" sends the body exactly as written', async () => {
    const client = new OFWClient();
    const spy = postMocks(client, 300, MD);
    setup(client);

    const phase1 = await callPreview(handlers.get('ofw_send_message')!, {
      subject: 'S', body: MD, recipientIds: [1], bodyFormat: 'plain',
    });
    expect(phase1.preview.body).toBe(MD);
    expect(phase1.preview).not.toHaveProperty('bodyConversion');

    await callConfirmed(handlers.get('ofw_send_message')!, { subject: 'S', body: MD, recipientIds: [1], bodyFormat: 'plain' });
    expect(postedBody(spy)).toBe(MD);
  });

  it('never rewrites a server draft body it sends by id — only a body the caller supplies', async () => {
    const serverDraft = {
      subject: 'S', body: MD, recipients: [], replyToId: null, folder: { id: '3', name: 'Drafts' },
    };
    cache.core.upsertDraft({
      id: 77, subject: 'S', body: MD, recipients: [], replyToId: null, modifiedAt: '2026-11-11T12:00:00', listData: {},
    });
    const client = new OFWClient();
    const spy = vi.spyOn(client, 'request')
      .mockResolvedValueOnce(serverDraft)
      .mockResolvedValueOnce(serverDraft)
      .mockResolvedValueOnce({ entityId: 301 })
      .mockResolvedValueOnce({
        id: 301, subject: 'S', body: MD, date: { dateTime: '2026-11-11T12:00:00' }, from: { name: 'Me' }, recipients: [],
      })
      .mockResolvedValueOnce({});
    setup(client);

    const res = await callConfirmed(handlers.get('ofw_send_message')!, { draftId: 77, recipientIds: [1] });

    expect(postedBody(spy)).toBe(MD);
    expect(res.content[0].text).not.toContain('bodyConversion');
  });
});
