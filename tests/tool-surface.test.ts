import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectToolRegistrars } from '../src/tool-surface.js';

describe('selectToolRegistrars', () => {
  const ONLY = 'OFW_EXPENSE_ONLY';
  const UPLOAD = 'OFW_EXPENSE_UPLOAD_ONLY';
  let prevOnly: string | undefined;
  let prevUpload: string | undefined;

  const registrars = {
    healthcheck: 'healthcheck',
    user: 'user',
    messages: 'messages',
    calendar: 'calendar',
    expenses: 'expenses',
    journal: 'journal',
  } as const;

  beforeEach(() => {
    prevOnly = process.env[ONLY];
    prevUpload = process.env[UPLOAD];
    delete process.env[ONLY];
    delete process.env[UPLOAD];
  });

  afterEach(() => {
    if (prevOnly === undefined) delete process.env[ONLY];
    else process.env[ONLY] = prevOnly;
    if (prevUpload === undefined) delete process.env[UPLOAD];
    else process.env[UPLOAD] = prevUpload;
    vi.restoreAllMocks();
  });

  it('returns the full registrar surface by default', () => {
    expect(selectToolRegistrars(registrars)).toEqual([
      'healthcheck',
      'user',
      'messages',
      'calendar',
      'expenses',
      'journal',
    ]);
  });

  it('removes every non-expense registrar in expense-only mode', () => {
    process.env[ONLY] = 'true';
    expect(selectToolRegistrars(registrars)).toEqual(['healthcheck', 'expenses']);
  });

  it('uses the same restricted registrar set in upload-only mode', () => {
    process.env[UPLOAD] = 'true';
    expect(selectToolRegistrars(registrars)).toEqual(['healthcheck', 'expenses']);
  });

  it('fails closed to the restricted registrar set on a typo', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env[ONLY] = 'treu';
    expect(selectToolRegistrars(registrars)).toEqual(['healthcheck', 'expenses']);
  });
});
