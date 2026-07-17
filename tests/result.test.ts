import { describe, expect, it } from 'vite-plus/test';

import { fail, formatResultSummary, ok, skipped } from '../lib/result.js';

describe('result constructors', () => {
  it('builds ok/skipped/fail results with and without details', () => {
    expect(ok('done')).toEqual({ ok: true, message: 'done' });
    expect(ok('done', { host: 'a' })).toEqual({
      ok: true,
      message: 'done',
      details: { host: 'a' },
    });

    expect(skipped('nochg')).toEqual({ ok: true, skipped: true, message: 'nochg' });
    expect(skipped('nochg', { host: 'a' })).toEqual({
      ok: true,
      skipped: true,
      message: 'nochg',
      details: { host: 'a' },
    });

    expect(fail('boom')).toEqual({ ok: false, message: 'boom' });
    expect(fail('boom', { code: 1 })).toEqual({ ok: false, message: 'boom', details: { code: 1 } });
  });
});

describe('formatResultSummary', () => {
  it('labels ok, skipped, and error results', () => {
    expect(formatResultSummary(ok('updated'))).toBe('[ok] updated');
    expect(formatResultSummary(skipped('nochg'))).toBe('[skipped] nochg');
    expect(formatResultSummary(fail('badauth'))).toBe('[error] badauth');
  });
});
