import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/server';
import { registerHealthcheckTools } from '../src/tools/healthcheck.js';
import { registerUserTools } from '../src/tools/user.js';
import { registerMessageTools } from '../src/tools/messages.js';
import { registerCalendarTools } from '../src/tools/calendar.js';
import { registerExpenseTools } from '../src/tools/expenses.js';
import { registerJournalTools } from '../src/tools/journal.js';
import { NodeAttachmentIO } from '../src/tools/attachments.js';
import type { CacheStore } from '../src/cache/store.js';
import type { OFWClient } from '../src/client.js';

/**
 * Every tool says what it is, and what it says is pinned.
 *
 * `destructiveHint` DEFAULTS TO TRUE whenever `readOnlyHint` is not true, so a
 * write that forgets it is published as destructive and nothing fails — a
 * considered `false` and a forgotten one leave identical annotations. The same
 * silence on `openWorldHint` leaves a host guessing whether the call leaves the
 * machine. The fleet lint (`audit-annotations.mjs --strict`) catches both on
 * the built server; this catches them before a build.
 *
 * The classification is the INVERSE TEST from the fleet builder skill:
 * `destructive: false` only when a later call in THIS tool set restores the
 * prior state. Anything the co-parent sees (a sent message, a shared event or
 * file, a "First Viewed" stamp, a last-seen update) has no inverse even when a
 * delete exists, because nothing un-shows it. The table below is that decision
 * per tool; changing a row should be a decision, not a side effect.
 *
 * The roster is read by REGISTERING, not by scanning source — the healthcheck
 * comes from a shared mcp-utils registrar no `registerTool('` grep can see.
 */
interface Ann { readOnlyHint?: unknown; destructiveHint?: unknown; openWorldHint?: unknown }

function registeredAnnotations(): Record<string, Ann | undefined> {
  const seen: Record<string, Ann | undefined> = {};
  const server = {
    registerTool: (name: string, cfg: { annotations?: Ann }) => {
      seen[name] = cfg.annotations;
    },
  } as unknown as McpServer;
  const client = {} as OFWClient;
  const cacheProvider = (): CacheStore => ({}) as CacheStore;
  registerHealthcheckTools(server, client);
  registerUserTools(server, client);
  registerMessageTools(server, client, cacheProvider, new NodeAttachmentIO());
  registerCalendarTools(server, client);
  registerExpenseTools(server, client, new NodeAttachmentIO());
  registerJournalTools(server, client);
  return seen;
}

type Kind = 'read' | 'additive' | 'destructive';
const kindOf = (a: Ann | undefined): Kind =>
  a?.readOnlyHint === true ? 'read' : a?.destructiveHint === false ? 'additive' : 'destructive';

const EXPECTED: Record<string, Kind> = {
  ofw_healthcheck: 'read',
  ofw_get_profile: 'read',
  // "updates your last-seen status" — co-parent-visible; nothing restores it.
  ofw_get_notifications: 'destructive',
  ofw_list_message_folders: 'read',
  ofw_list_messages: 'read',
  // An uncached unread inbox fetch stamps "First Viewed" — irreversible.
  ofw_get_message: 'destructive',
  ofw_send_message: 'destructive',
  // verify:true refreshes only the local drafts cache; drafts stamp nothing.
  ofw_list_drafts: 'additive',
  // Replacing a draft deletes the old one.
  ofw_save_draft: 'destructive',
  ofw_delete_draft: 'destructive',
  ofw_get_unread_sent: 'read',
  // shareClass:"SHARED" is co-parent-visible at once; no tool deletes a My Files upload.
  ofw_upload_attachment: 'destructive',
  // force:true replaces an existing local file; nothing restores it.
  ofw_download_attachment: 'destructive',
  // fetchUnreadBodies:true stamps "First Viewed" on every unread message it touches.
  ofw_sync_messages: 'destructive',
  // allowMarkRead:true probes unread inbox ids by fetching them, which stamps "First Viewed".
  ofw_check_freshness: 'destructive',
  ofw_status: 'destructive',
  ofw_list_events: 'read',
  // A shared event is on the co-parent's calendar at once; ofw_delete_event cannot un-show it.
  ofw_create_event: 'destructive',
  ofw_update_event: 'destructive',
  ofw_delete_event: 'destructive',
  ofw_get_expense_totals: 'read',
  ofw_list_expense_categories: 'read',
  ofw_list_expenses: 'read',
  // Always uploaded SHARED (co-parent-visible); no tool deletes it.
  ofw_upload_expense_pdf: 'destructive',
  ofw_update_expense: 'destructive',
  ofw_create_expense: 'destructive',
  ofw_list_journal_entries: 'read',
  // Lands on the court-visible record; no tool edits or deletes a journal entry.
  ofw_create_journal_entry: 'destructive',
};

describe('tool annotations', () => {
  const KEYS = ['OFW_WRITE_MODE', 'OFW_EXPENSE_ONLY', 'OFW_EXPENSE_UPLOAD_ONLY'] as const;
  const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    // The full surface: the write tools are only registered in mode "all".
    process.env.OFW_WRITE_MODE = 'all';
    delete process.env.OFW_EXPENSE_ONLY;
    delete process.env.OFW_EXPENSE_UPLOAD_ONLY;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('registers the full surface (guards against a registrar being dropped here)', () => {
    expect(Object.keys(registeredAnnotations()).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('sets an explicit boolean destructiveHint on every write', () => {
    const undeclared = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint !== true && typeof a?.destructiveHint !== 'boolean')
      .map(([name]) => name);
    expect(undeclared).toEqual([]);
  });

  it('never lets a read claim to be destructive', () => {
    const contradictory = Object.entries(registeredAnnotations())
      .filter(([, a]) => a?.readOnlyHint === true && a?.destructiveHint === true)
      .map(([name]) => name);
    expect(contradictory).toEqual([]);
  });

  it('sets an explicit boolean openWorldHint on every tool (all of them reach ourfamilywizard.com)', () => {
    const ann = registeredAnnotations();
    expect(Object.entries(ann).filter(([, a]) => a?.openWorldHint !== true).map(([n]) => n)).toEqual([]);
  });

  it('classifies each tool by the inverse test', () => {
    const ann = registeredAnnotations();
    const actual = Object.fromEntries(Object.keys(EXPECTED).map((n) => [n, kindOf(ann[n])]));
    expect(actual).toEqual(EXPECTED);
  });
});
