import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  combineAnnouncementSources,
  fetchStatusNotices,
  mergeAnnouncements,
  parseStatusDocument,
  parseStatusNotice,
} from '../../src/lib/platformStatusNotices.ts';
import { buildStatusDocument } from '../../scripts/status-notice.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const NOW = Date.parse('2026-10-16T12:00:00Z');

const notice = (over = {}) => ({
  id: 'status-123',
  title: 'API maintenance',
  message: 'Sign-in may fail for a few minutes.',
  severity: 'maintenance',
  updated_at: '2026-10-16T11:00:00Z',
  ...over,
});

const dbRow = (over = {}) => ({
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  title: 'DB notice',
  message: 'From the database',
  severity: 'info',
  scheduled_start: null,
  scheduled_end: null,
  refresh_instructions: null,
  is_active: true,
  starts_at: '2026-10-16T00:00:00Z',
  ends_at: null,
  created_at: '2026-10-16T00:00:00Z',
  updated_at: '2026-10-16T00:00:00Z',
  ...over,
});

const response = (body, { status = 200, type = 'application/json' } = {}) => ({
  status,
  headers: { get: (name) => (name.toLowerCase() === 'content-type' ? type : null) },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('status.json is fetched without cache and parsed into banner rows', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return response({ announcements: [notice()] });
  };
  const rows = await fetchStatusNotices(fetchImpl, NOW);
  assert.deepEqual(calls, [{ url: '/status.json', init: { cache: 'no-store', credentials: 'omit' } }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'status-123');
  assert.equal(rows[0].is_active, true);
  assert.equal(rows[0].updated_at, '2026-10-16T11:00:00Z');
});

test('the workflow script output is accepted by the banner parser', () => {
  const built = buildStatusDocument({
    environment: 'staging', action: 'post', title: 'T', message: 'M', severity: 'critical',
    ends_at: '2026-10-17T00:00:00Z', refresh_instructions: 'Reload',
  }, { now: new Date(NOW), runId: '987' });
  assert.equal(built.ok, true);
  const rows = parseStatusDocument(built.document);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].severity, 'critical');
  assert.equal(rows[0].refresh_instructions, 'Reload');
});

test('merge with database rows is de-duplicated by id', () => {
  const staticRows = parseStatusDocument({ announcements: [notice(), notice({ id: dbRow().id, title: 'dup' })] });
  const merged = combineAnnouncementSources({ data: [dbRow()], error: null }, staticRows, NOW);
  assert.deepEqual(merged.map((a) => a.id), [dbRow().id, 'status-123']);
  assert.equal(merged[0].title, 'DB notice', 'database row wins on a duplicate id');
  assert.equal(mergeAnnouncements(null, staticRows).length, 2);
});

test('401 or failed database read falls back to the static notices alone', () => {
  const staticRows = parseStatusDocument({ announcements: [notice()] });
  const unauthorized = { data: null, error: { message: 'JWT expired', code: 'PGRST301' } };
  assert.deepEqual(combineAnnouncementSources(unauthorized, staticRows, NOW), staticRows);
  assert.deepEqual(combineAnnouncementSources({ data: null, error: new Error('network') }, staticRows, NOW), staticRows);
  assert.deepEqual(combineAnnouncementSources(null, staticRows, NOW), staticRows);
  assert.deepEqual(combineAnnouncementSources(unauthorized, [], NOW), []);
});

test('database rows outside their window are dropped', () => {
  const rows = combineAnnouncementSources({
    data: [dbRow({ ends_at: '2026-10-16T11:59:00Z' }), dbRow({ id: 'b', starts_at: '2026-10-17T00:00:00Z' })],
    error: null,
  }, [], NOW);
  assert.equal(rows.length, 0);
});

test('malformed, non-200 or non-JSON status.json is ignored', async () => {
  const cases = [
    response('<!doctype html><html></html>', { type: 'text/html' }), // CloudFront SPA fallback
    response({ announcements: [notice()] }, { status: 404 }),
    response({ announcements: [notice()] }, { status: 304 }),
    response('{not json', { type: 'application/json' }),
    response({ notices: [notice()] }),
    response([notice()]),
    response({ announcements: 'x' }),
    response('x'.repeat(70 * 1024)),
  ];
  for (const res of cases) {
    assert.deepEqual(await fetchStatusNotices(async () => res, NOW), []);
  }
  assert.deepEqual(await fetchStatusNotices(async () => { throw new Error('offline'); }, NOW), []);
  assert.deepEqual(await fetchStatusNotices(undefined, NOW), []);
});

test('each notice is validated strictly', () => {
  assert.ok(parseStatusNotice(notice()));
  const bad = [
    notice({ id: '' }),
    notice({ id: '../x' }),
    notice({ id: 5 }),
    notice({ title: '' }),
    notice({ title: 'x'.repeat(121) }),
    notice({ message: 'x'.repeat(2001) }),
    notice({ message: { html: '<b>' } }),
    notice({ refresh_instructions: 'x'.repeat(501) }),
    notice({ severity: 'urgent' }),
    notice({ updated_at: 'yesterday' }),
    notice({ updated_at: undefined }),
    notice({ starts_at: '2026-10-16' }),
    notice({ starts_at: '2026-10-16T10:00:00Z', ends_at: '2026-10-16T09:00:00Z' }),
    notice({ link: 'https://example.com' }),
    notice({ html: '<script>' }),
    notice({ title: 'bell\u0007' }),
  ];
  for (const raw of bad) assert.equal(parseStatusNotice(raw), null, JSON.stringify(raw));
  const doc = parseStatusDocument({ announcements: [notice({ id: 'a' }), notice({ severity: 'nope' }), notice({ id: 'b' })] });
  assert.deepEqual(doc.map((a) => a.id), ['a', 'b'], 'bad entries are dropped individually');
  assert.equal(parseStatusDocument({ announcements: Array.from({ length: 20 }, (_, i) => notice({ id: `n${i}` })) }).length, 10);
});

test('notices outside their window are not shown', async () => {
  const future = notice({ starts_at: '2026-10-17T00:00:00Z' });
  const past = notice({ id: 'p', ends_at: '2026-10-16T11:00:00Z' });
  assert.deepEqual(await fetchStatusNotices(async () => response({ announcements: [future, past] }), NOW), []);
});

test('notice text stays plain text and the banner renders it only as React text', () => {
  const html = '<img src=x onerror=alert(1)> <a href="javascript:alert(1)">click</a>';
  const [row] = parseStatusDocument({ announcements: [notice({ title: html, message: html })] });
  assert.equal(row.title, html, 'kept verbatim as a string, never parsed');
  assert.equal(row.message, html);

  const banner = fs.readFileSync(path.join(ROOT, 'src/components/platform/PlatformAnnouncementBanner.tsx'), 'utf8');
  assert.doesNotMatch(banner, /dangerouslySetInnerHTML|innerHTML|<a\s|href=/);
  assert.match(banner, /\{a\.title\}/);
  assert.match(banner, /\{a\.message\}/);
  assert.match(banner, /\{a\.refresh_instructions\}/);
  // Critical notices still cannot be dismissed.
  assert.match(banner, /a\.severity !== "critical" && \(/);
});

test('hook keeps 30 s polling and merges status.json with the database query', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'src/hooks/usePlatformAnnouncements.ts'), 'utf8');
  assert.match(hook, /refetchInterval: 30_000/);
  assert.match(hook, /fetchStatusNotices\(\)/);
  assert.match(hook, /combineAnnouncementSources\(db, staticNotices\)/);
});

test('status.json is never shipped in the SPA build', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'public/status.json')), false);
});

test('admin manager writes through the owner-only function, not table writes', () => {
  const manager = fs.readFileSync(path.join(ROOT, 'src/components/admin/PlatformAnnouncementsManager.tsx'), 'utf8');
  assert.match(manager, /supabase\.functions\.invoke\("platform-announcements"/);
  assert.doesNotMatch(manager, /\.(insert|update|delete)\(/);
});
