import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestHarness, type TestHarness } from '@chrischall/mcp-utils/test';
import { OFWClient } from '../src/client.js';
import { OFWCache } from '../src/cache/node.js';
import type { CacheStore } from '../src/cache/store.js';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { calendarBriefLines, registerCalendarTools } from '../src/tools/calendar.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerJournalTools } from '../src/tools/journal.js';
import { NodeAttachmentIO } from '../src/tools/attachments.js';
import { BRIEF_MAX, briefLine, briefDate, briefText } from '../src/tools/hints.js';
import { sampleMessageRow } from './_fixtures.js';

/**
 * Context-group hints (`_meta.mint`, the mcp-host context-groups contract),
 * read off `tools/list` — what a host sees — for the full surface.
 */
type Listed = {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema: { properties?: Record<string, { enum?: string[] }> };
  _meta?: { mint?: Record<string, unknown> };
};

const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];
const CANONICAL_INTENTS = ['whats-new', 'whats-due', 'whats-on'];

/** The intent every tool declares — this table is the assertion. */
const EXPECTED_INTENT: Record<string, string> = {
  ofw_get_profile: 'lookup',
  ofw_get_notifications: 'whats-new',
  ofw_list_message_folders: 'lookup',
  ofw_list_messages: 'whats-new',
  ofw_get_message: 'lookup',
  ofw_send_message: 'send',
  ofw_list_drafts: 'lookup',
  ofw_save_draft: 'change',
  ofw_delete_draft: 'change',
  ofw_get_unread_sent: 'lookup',
  ofw_upload_attachment: 'other',
  ofw_download_attachment: 'other',
  ofw_sync_messages: 'other',
  ofw_check_freshness: 'other',
  ofw_status: 'other',
  ofw_list_events: 'whats-on',
  ofw_save_calendar_ics: 'other',
  ofw_create_event: 'change',
  ofw_update_event: 'change',
  ofw_delete_event: 'change',
  ofw_get_expense_totals: 'lookup',
  ofw_list_expense_categories: 'lookup',
  ofw_list_expenses: 'lookup',
  ofw_upload_expense_pdf: 'other',
  ofw_update_expense: 'change',
  ofw_mark_expense_reimbursed: 'change',
  ofw_create_expense: 'change',
  ofw_list_journal_entries: 'lookup',
  ofw_create_journal_entry: 'change',
};

const ENV_KEYS = ['OFW_WRITE_MODE', 'OFW_EXPENSE_ONLY', 'OFW_EXPENSE_UPLOAD_ONLY'] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let cache: OFWCache;
let client: OFWClient;

async function harness(): Promise<TestHarness> {
  const cacheProvider = (): CacheStore => cache;
  const io = new NodeAttachmentIO();
  return createTestHarness((server) => {
    registerHealthcheckTools(server, client);
    registerUserTools(server, client);
    registerMessageTools(server, client, cacheProvider, io);
    registerCalendarTools(server, client, io);
    registerExpenseTools(server, client, io);
    registerJournalTools(server, client);
  });
}

async function served(): Promise<Listed[]> {
  const h = await harness();
  const { tools } = await h.client.listTools();
  await h.close();
  return tools as Listed[];
}

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  // The full surface: the write tools are only registered in mode "all".
  process.env.OFW_WRITE_MODE = 'all';
  delete process.env.OFW_EXPENSE_ONLY;
  delete process.env.OFW_EXPENSE_UPLOAD_ONLY;
  cache = OFWCache.open(':memory:');
  client = new OFWClient();
});

afterEach(() => {
  cache.close();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('_meta.mint on tools/list', () => {
  it('hints every served tool except the mcp-utils healthcheck, so a new tool cannot skip the decision', async () => {
    const tools = await served();
    const hinted = tools.filter((t) => t._meta?.mint).map((t) => t.name).sort();
    expect(hinted).toEqual(Object.keys(EXPECTED_INTENT).sort());
    // ofw_healthcheck is registered by mcp-utils and joins no group.
    expect(tools.filter((t) => !t._meta?.mint).map((t) => t.name)).toEqual(['ofw_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s declares domain family and intent %s', async (name, intent) => {
    const mint = (await served()).find((t) => t.name === name)?._meta?.mint;
    expect(mint?.domain).toBe('family');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract, and names only arguments that exist', async () => {
    for (const t of await served()) {
      const mint = t._meta?.mint;
      if (!mint) continue;
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      const props = t.inputSchema.properties ?? {};
      if ('subject' in mint) expect(props, t.name).toHaveProperty(mint.subject as string);
      if ('when' in mint) {
        const when = mint.when as Record<string, string>;
        expect(Object.keys(when).sort(), t.name).toEqual(['end', 'start']);
        expect(props, t.name).toHaveProperty(when.start);
        expect(props, t.name).toHaveProperty(when.end);
      }
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
          expect(a, t.name).not.toMatch(/^ofw_/);
        }
      }
    }
  });

  it('canonical only on read-only whats-new/due/on reads, at most one per intent', async () => {
    const canonical = (await served()).filter((t) => t._meta?.mint?.canonical !== undefined);
    for (const t of canonical) {
      expect(t._meta!.mint!.canonical, t.name).toBe(true);
      expect(t.annotations?.readOnlyHint, t.name).toBe(true);
      expect(CANONICAL_INTENTS, t.name).toContain(t._meta!.mint!.intent);
    }
    const intents = canonical.map((t) => t._meta!.mint!.intent);
    expect(new Set(intents).size).toBe(intents.length);
    expect(canonical.map((t) => [t.name, t._meta!.mint!.intent]).sort()).toEqual([
      ['ofw_list_events', 'whats-on'],
      ['ofw_list_messages', 'whats-new'],
    ]);
  });

  it('the canonical reads name their range arguments and no subject (OFW has no per-child argument)', async () => {
    const tools = await served();
    const messages = tools.find((t) => t.name === 'ofw_list_messages')!;
    expect(messages._meta?.mint).toMatchObject({ when: { start: 'since', end: 'until' } });
    expect(messages._meta?.mint).not.toHaveProperty('subject');
    const events = tools.find((t) => t.name === 'ofw_list_events')!;
    expect(events._meta?.mint).toMatchObject({ when: { start: 'startDate', end: 'endDate' } });
    expect(events._meta?.mint).not.toHaveProperty('subject');
  });

  it('every canonical read offers view "brief"', async () => {
    for (const t of (await served()).filter((x) => x._meta?.mint?.canonical)) {
      expect(t.inputSchema.properties?.view?.enum, t.name).toContain('brief');
    }
  });
});

const BRIEF_SHAPE = /^.+ — (\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:\d{2}|Z))?|no date) — \S.*$/;

function expectBrief(text: string, count: number) {
  const lines = text.split('\n');
  expect(lines).toHaveLength(count);
  for (const line of lines) {
    expect(line.length, line).toBeLessThanOrEqual(BRIEF_MAX);
    expect(line, line).toMatch(BRIEF_SHAPE);
  }
  return lines;
}

describe('briefLine', () => {
  it('joins title, date and status', () => {
    expect(briefLine('Recital', '2026-09-05', 'event')).toBe('Recital — 2026-09-05 — event');
  });

  it('says "no date" when there is none, and names an empty title', () => {
    expect(briefLine('', null, 'unread')).toBe('(untitled) — no date — unread');
  });

  it('truncates a long title so the line fits', () => {
    const line = briefLine('x'.repeat(300), '2026-09-05T17:00:00-04:00', 'unread');
    expect(line.length).toBe(BRIEF_MAX);
    expect(line).toMatch(/^x+… — 2026-09-05T17:00:00-04:00 — unread$/);
  });

  it('collapses newlines in a title onto one line', () => {
    expect(briefLine('a\nb', null, 'read')).toBe('a b — no date — read');
  });
});

describe('briefDate', () => {
  it('renders a naive wall-clock time with the zone offset', () => {
    expect(briefDate('2026-09-05T17:00:00', 'America/New_York')).toBe('2026-09-05T17:00:00-04:00');
  });
  it('keeps a bare date as a date', () => {
    expect(briefDate('2026-09-05', 'America/New_York')).toBe('2026-09-05');
  });
  it('answers null for anything that is not a date', () => {
    expect(briefDate('soon', 'America/New_York')).toBeNull();
    expect(briefDate(undefined, 'America/New_York')).toBeNull();
  });
});

describe('ofw_list_messages view "brief"', () => {
  it('answers one line per message: sender and subject, sent time, read state', async () => {
    cache.core.upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox', subject: 'Pickup Friday', fromUser: 'Parent B', sentAt: '2026-09-04T09:30:00', fetchedBodyAt: null, recipients: [], listData: { read: false } }));
    cache.core.upsertMessage(sampleMessageRow({ id: 2, folder: 'sent', subject: 'Re: Pickup Friday', fromUser: '', sentAt: '2026-09-04T10:00:00', listData: {} }));
    cache.core.upsertMessage(sampleMessageRow({ id: 3, folder: 'inbox', subject: 'Dentist', fromUser: 'Parent B', sentAt: 'not a time', listData: { read: true } }));
    const spy = vi.spyOn(client, 'request');
    const h = await harness();
    const result = await h.callTool('ofw_list_messages', { view: 'brief', sort: 'oldest' });
    await h.close();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const lines = expectBrief(text, 3);
    expect(lines).toContain('Parent B: Pickup Friday — 2026-09-04T09:30:00-04:00 — unread');
    expect(lines).toContain('Re: Pickup Friday — 2026-09-04T10:00:00-04:00 — sent');
    expect(lines).toContain('Parent B: Dentist — no date — read');
    expect(spy).not.toHaveBeenCalled();
  });

  it('ends a page that is not the whole result with a "-- N of M shown" note', async () => {
    for (let id = 1; id <= 3; id++) {
      cache.core.upsertMessage(sampleMessageRow({ id, folder: 'inbox', subject: `Note ${id}`, fromUser: 'Parent B', sentAt: `2026-09-0${id}T09:30:00`, recipients: [], listData: { read: true } }));
    }
    const h = await harness();
    const first = await h.callTool('ofw_list_messages', { view: 'brief', size: 2 });
    const second = await h.callTool('ofw_list_messages', { view: 'brief', size: 2, page: 2 });
    await h.close();
    const firstLines = (first.content as Array<{ type: string; text: string }>)[0].text.split('\n');
    expect(firstLines).toHaveLength(3);
    expectBrief(firstLines.slice(0, 2).join('\n'), 2);
    expect(firstLines[2]).toBe('-- 2 of 3 shown');
    const secondLines = (second.content as Array<{ type: string; text: string }>)[0].text.split('\n');
    expect(secondLines).toEqual([expect.stringMatching(/^Parent B: Note 1 — /), '-- 1 of 3 shown']);
  });

  it('adds no note when the page is the whole result', async () => {
    cache.core.upsertMessage(sampleMessageRow({ id: 1, folder: 'inbox', subject: 'Only one', fromUser: 'Parent B', sentAt: '2026-09-04T09:30:00', recipients: [], listData: { read: true } }));
    const h = await harness();
    const result = await h.callTool('ofw_list_messages', { view: 'brief' });
    await h.close();
    expectBrief((result.content as Array<{ type: string; text: string }>)[0].text, 1);
  });

  it('answers "-- none" when a verified-fresh cache holds no matching message', async () => {
    const now = new Date().toISOString();
    for (const folder of ['inbox', 'sent'] as const) {
      cache.core.setSyncState(folder, { lastSyncAt: now, newestId: null, resumePage: null });
      cache.core.setMeta(`folder_verified_at:${folder}`, now);
    }
    const h = await harness();
    const result = await h.callTool('ofw_list_messages', { view: 'brief' });
    await h.close();
    expect(result.isError).toBeFalsy();
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('-- none');
  });
});

describe('briefText', () => {
  it('joins the lines and adds no note for a whole result', () => {
    expect(briefText(['a', 'b'])).toBe('a\nb');
    expect(briefText(['a', 'b'], { shown: 2, total: 2 })).toBe('a\nb');
  });

  it('answers "-- none" for no lines', () => {
    expect(briefText([])).toBe('-- none');
    expect(briefText([], { shown: 0, total: 0 })).toBe('-- none');
  });

  it('notes a partial page, even one past the end', () => {
    expect(briefText(['a'], { shown: 1, total: 5 })).toBe('a\n-- 1 of 5 shown');
    expect(briefText([], { shown: 0, total: 5 })).toBe('-- 0 of 5 shown');
  });
});

describe('ofw_list_events view "brief"', () => {
  const CALENDAR = {
    calendarItems: [
      { id: 1, type: 'TRANSITION', allDay: false, startDate: { dateTime: '2026-09-04T12:00:00' }, transitionStartParent: { userId: 101, name: 'Parent A' }, transitionEndParent: { userId: 202, name: 'Parent B' } },
      { id: 1, type: 'TRANSITION', allDay: false, startDate: { dateTime: '2026-09-07T00:00:00' }, transitionStartParent: { userId: 202, name: 'Parent B' }, transitionEndParent: null },
      { id: 55, type: 'EVENT', allDay: false, title: 'Recital', startDate: { dateTime: '2026-09-05T17:00:00' }, endDate: { dateTime: '2026-09-05T18:00:00' } },
      { id: 56, type: 'EVENT', allDay: true, title: 'No school', startDate: { dateTime: '2026-09-06T00:00:00' } },
      { id: 57, type: 'CONNECTED_EVENT', allDay: false, startDate: {} },
      'junk',
    ],
    guardianData: { '2026-09-04': [{ guardianId: 101, type: 'SCHEDULE', id: 9 }] },
  };

  it('reads the detailed calendar and answers one line per item, never the custody grid', async () => {
    const spy = vi.spyOn(client, 'request').mockResolvedValue(CALENDAR);
    const h = await harness();
    const result = await h.callTool('ofw_list_events', { startDate: '2026-09-01', endDate: '2026-09-07', view: 'brief', timeZone: 'America/New_York' });
    await h.close();
    expect(spy).toHaveBeenCalledWith('GET', '/pub/v1/calendar/detailed?startDate=2026-09-01&endDate=2026-09-07');
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(expectBrief(text, 5)).toEqual([
      'Custody handoff to Parent B — 2026-09-04T12:00:00-04:00 — handoff',
      'Custody handoff — 2026-09-07T00:00:00-04:00 — handoff',
      'Recital — 2026-09-05T17:00:00-04:00 — event',
      'No school — 2026-09-06 — all day',
      '(untitled) — no date — outside calendar',
    ]);
  });

  it('honours the types filter', async () => {
    vi.spyOn(client, 'request').mockResolvedValue(CALENDAR);
    const h = await harness();
    const result = await h.callTool('ofw_list_events', { startDate: '2026-09-01', endDate: '2026-09-07', view: 'brief', types: ['EVENT'] });
    await h.close();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(expectBrief(text, 2)[0]).toMatch(/^Recital — /);
  });

  it('answers "-- none" when the calendar holds nothing', async () => {
    vi.spyOn(client, 'request').mockResolvedValue({ calendarItems: [] });
    const h = await harness();
    const result = await h.callTool('ofw_list_events', { startDate: '2026-09-01', endDate: '2026-09-07', view: 'brief' });
    await h.close();
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('-- none');
  });

  it('answers "-- none" when the types filter leaves nothing', async () => {
    vi.spyOn(client, 'request').mockResolvedValue(CALENDAR);
    const h = await harness();
    const result = await h.callTool('ofw_list_events', { startDate: '2026-09-01', endDate: '2026-09-07', view: 'brief', types: ['SCHEDULE'] });
    await h.close();
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('-- none');
  });
});

describe('calendarBriefLines', () => {
  it('answers no lines for a payload that is not a calendar', () => {
    expect(calendarBriefLines(null, 'America/New_York')).toEqual([]);
    expect(calendarBriefLines({ calendarItems: 'nope' }, 'America/New_York')).toEqual([]);
  });

  it('says "no date" for an item with no start, timed or all-day', () => {
    expect(calendarBriefLines({ calendarItems: [
      { type: 'EVENT', title: 'Camp' },
      { type: 'EVENT', title: 'Camp week', allDay: true, startDate: {} },
    ] }, 'America/New_York')).toEqual(['Camp — no date — event', 'Camp week — no date — all day']);
  });
});
