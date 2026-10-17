import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ANNOUNCEMENT_LIMITS,
  handlePlatformAnnouncements,
  validateAnnouncementFields,
  validateWindow,
} from '../functions/api/platform-announcements.mjs';
import { CLASS_A_FUNCTIONS, handleAppServiceRequest } from '../functions/api/app-services.mjs';
import { IS_PLATFORM_OWNER_SQL } from '../functions/api/data.mjs';
import { LOOKUP_MAPPING_SQL } from '../functions/api/identity.mjs';

const APP_ID = 'abd3c2a0-6dc0-4680-92dd-a013e1141c91';
const COGNITO_SUB = 'c4386408-60e1-70e2-abb6-e6194e8e635f';
const ROW_ID = '11111111-2222-4333-8444-555555555555';
const FN_PATH = '/functions/v1/platform-announcements';

const jwtEvent = (body, { signedIn = true } = {}) => ({
  rawPath: FN_PATH,
  headers: signedIn ? { authorization: 'Bearer test-id-token' } : {},
  body: body ? JSON.stringify(body) : undefined,
  requestContext: {
    stage: 'staging',
    http: { method: 'POST', path: FN_PATH },
    requestId: 'req-platform-announcements-test',
    ...(signedIn ? {
      authorizer: { jwt: { claims: { sub: COGNITO_SUB, email: 'owner@example.com', token_use: 'id' } } },
    } : {}),
  },
});

const existingRow = {
  id: ROW_ID,
  title: 'Old',
  message: 'Old message',
  severity: 'info',
  scheduled_start: null,
  scheduled_end: null,
  refresh_instructions: null,
  is_active: true,
  starts_at: new Date('2026-10-01T00:00:00Z'),
  ends_at: null,
  created_by: APP_ID,
  created_at: new Date('2026-10-01T00:00:00Z'),
  updated_at: new Date('2026-10-01T00:00:00Z'),
};

/**
 * isOwner: what public.is_platform_owner() returns for the caller.
 * platformRoles / tenantRole model a global admin or tenant member who is not the owner.
 */
const mockClient = ({ isOwner = false, platformRoles = [], tenantRole = null, row = existingRow } = {}) => {
  const queries = [];
  return {
    queries,
    connect: async () => {},
    end: async () => {},
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (['BEGIN', 'ROLLBACK', 'SET TRANSACTION READ WRITE'].includes(sql)) return { rows: [] };
      if (sql === 'COMMIT') return { rows: [], command: 'COMMIT' };
      if (sql.startsWith('SELECT set_config')) return { rows: [{ set_config: params[1] }] };
      if (sql === LOOKUP_MAPPING_SQL) {
        return {
          rows: params[0] === COGNITO_SUB
            ? [{ application_user_id: APP_ID, cognito_sub: COGNITO_SUB, email: 'owner@example.com', status: 'active' }]
            : [],
        };
      }
      if (sql === IS_PLATFORM_OWNER_SQL) return { rows: [{ is_owner: isOwner }] };
      if (/FROM public\.user_roles/.test(sql)) return { rows: platformRoles.map((role) => ({ role })) };
      if (/FROM public\.tenant_users/.test(sql)) return { rows: tenantRole ? [{ role: tenantRole }] : [] };
      if (/INSERT INTO public\.platform_announcements/.test(sql)) {
        return { rows: [{ ...existingRow, title: params[0], message: params[1], severity: params[2] }] };
      }
      if (/SELECT .* FROM public\.platform_announcements WHERE id/s.test(sql)) return { rows: row ? [row] : [] };
      if (/UPDATE public\.platform_announcements/.test(sql)) return { rows: row ? [{ ...row, is_active: false }] : [] };
      if (/DELETE FROM public\.platform_announcements/.test(sql)) return { rows: row ? [row] : [] };
      if (/FROM public\.platform_announcements/.test(sql)) return { rows: [existingRow] };
      if (/INSERT INTO public\.audit_logs/.test(sql)) return { rows: [{ id: 'audit-1' }], rowCount: 1 };
      return { rows: [] };
    },
  };
};

const depsFor = (client) => ({
  loadDatabaseCredentials: async () => ({
    username: 'checksops',
    password: 'unit-test-only-not-a-real-secret',
    host: 'db.example.internal',
    database: 'checksops',
  }),
  createClient: () => client,
});

const validCreate = {
  action: 'create',
  title: 'Scheduled maintenance',
  message: 'The platform will be briefly unavailable.',
  severity: 'maintenance',
  ends_at: '2099-01-01T00:00:00Z',
};

const wrote = (client, re) => client.queries.some((q) => re.test(q.sql));

test('app-services routes platform-announcements to the owner-only handler', () => {
  assert.equal(CLASS_A_FUNCTIONS.has('platform-announcements'), true);
});

test('platform owner can create; write is audited and committed in one transaction', async () => {
  const client = mockClient({ isOwner: true });
  const result = await handlePlatformAnnouncements(jwtEvent({ ...validCreate, created_by: 'spoof' }), depsFor(client));
  assert.equal(result.statusCode, 200);
  assert.equal(result.ok, true);
  assert.equal(result.announcement.title, 'Scheduled maintenance');
  const sqls = client.queries.map((q) => q.sql);
  assert.ok(sqls.includes('SET TRANSACTION READ WRITE'));
  assert.ok(sqls.includes('COMMIT'));
  assert.ok(sqls.indexOf(IS_PLATFORM_OWNER_SQL) < sqls.findIndex((s) => /INSERT INTO public\.platform_announcements/.test(s)));
  const insert = client.queries.find((q) => /INSERT INTO public\.platform_announcements/.test(q.sql));
  assert.equal(insert.params.at(-1), APP_ID, 'created_by is the caller, never the request body');
  const audit = client.queries.find((q) => /INSERT INTO public\.audit_logs/.test(q.sql));
  assert.equal(audit.params[1], 'platform_announcement.create');
  assert.equal(audit.params[2], 'platform_announcement');
});

test('platform owner can list, update and delete', async () => {
  const list = await handlePlatformAnnouncements(jwtEvent({ action: 'list' }), depsFor(mockClient({ isOwner: true })));
  assert.equal(list.statusCode, 200);
  assert.equal(list.announcements.length, 1);

  const updClient = mockClient({ isOwner: true });
  const upd = await handlePlatformAnnouncements(jwtEvent({ action: 'update', id: ROW_ID, is_active: false }), depsFor(updClient));
  assert.equal(upd.statusCode, 200);
  assert.equal(upd.announcement.is_active, false);
  const update = updClient.queries.find((q) => /UPDATE public\.platform_announcements/.test(q.sql));
  assert.match(update.sql, /SET is_active = \$2::boolean, updated_at = now\(\)/);
  assert.ok(wrote(updClient, /INSERT INTO public\.audit_logs/));

  const delClient = mockClient({ isOwner: true });
  const del = await handlePlatformAnnouncements(jwtEvent({ action: 'delete', id: ROW_ID }), depsFor(delClient));
  assert.equal(del.statusCode, 200);
  assert.equal(del.deleted, ROW_ID);
  assert.ok(wrote(delClient, /INSERT INTO public\.audit_logs/));
});

for (const [label, opts] of [
  ['tenant member', { tenantRole: 'owner' }],
  ['global user_roles admin', { platformRoles: ['admin'] }],
]) {
  test(`${label} is refused for every action and nothing is written`, async () => {
    for (const body of [validCreate, { action: 'list' }, { action: 'update', id: ROW_ID, is_active: false }, { action: 'delete', id: ROW_ID }]) {
      const client = mockClient(opts);
      const result = await handlePlatformAnnouncements(jwtEvent(body), depsFor(client));
      assert.equal(result.statusCode, 403, `${label} ${body.action}`);
      assert.equal(result.code, 'platform_owner_required');
      assert.equal(wrote(client, /(INSERT INTO|UPDATE|DELETE FROM) public\./), false);
      assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);
    }
  });
}

test('anonymous caller is refused with 401 before any database access', async () => {
  const client = mockClient({ isOwner: true });
  const result = await handlePlatformAnnouncements(jwtEvent(validCreate, { signedIn: false }), depsFor(client));
  assert.equal(result.statusCode, 401);
  assert.equal(client.queries.length, 0);
  const routed = await handleAppServiceRequest(jwtEvent(validCreate, { signedIn: false }), FN_PATH, 'POST');
  assert.equal(routed.statusCode, 401);
});

test('unknown action is refused', async () => {
  const result = await handlePlatformAnnouncements(jwtEvent({ action: 'upsert' }), depsFor(mockClient({ isOwner: true })));
  assert.equal(result.statusCode, 400);
  assert.equal(result.error, 'unknown_action');
});

test('validation: lengths, severity, timestamps and window', async () => {
  const base = { title: 'T', message: 'M', severity: 'info' };
  assert.equal(validateAnnouncementFields(base).ok, true);
  assert.equal(validateAnnouncementFields({ ...base, title: 'x'.repeat(ANNOUNCEMENT_LIMITS.title) }).ok, true);
  assert.equal(validateAnnouncementFields({ ...base, title: 'x'.repeat(121) }).field, 'title');
  assert.equal(validateAnnouncementFields({ ...base, message: 'x'.repeat(2001) }).field, 'message');
  assert.equal(validateAnnouncementFields({ ...base, refresh_instructions: 'x'.repeat(501) }).field, 'refresh_instructions');
  assert.equal(validateAnnouncementFields({ ...base, title: '  ' }).error, 'missing_required_field');
  assert.equal(validateAnnouncementFields({ ...base, message: 42 }).error, 'invalid_field');
  assert.equal(validateAnnouncementFields({ ...base, severity: 'urgent' }).field, 'severity');
  assert.equal(validateAnnouncementFields({ ...base, is_active: 'yes' }).field, 'is_active');
  assert.equal(validateAnnouncementFields({ ...base, starts_at: '2026-10-20' }).error, 'invalid_timestamp');
  assert.equal(validateAnnouncementFields({ ...base, ends_at: '2026-10-20T10:00:00' }).error, 'invalid_timestamp');
  assert.equal(validateAnnouncementFields({ ...base, ends_at: 'tomorrow' }).error, 'invalid_timestamp');
  assert.equal(validateAnnouncementFields({ ...base, starts_at: null }).field, 'starts_at');
  assert.equal(validateAnnouncementFields({ ...base, ends_at: '2026-10-20T10:00:00+02:00' }).values.ends_at, '2026-10-20T08:00:00.000Z');
  assert.equal(validateWindow({ starts_at: '2026-10-20T10:00:00Z', ends_at: '2026-10-20T09:00:00Z' }).error, 'ends_at_before_starts_at');
  assert.equal(validateWindow({ starts_at: '2026-10-20T10:00:00Z', ends_at: '2026-10-20T10:00:00Z' }).ok, false);
  assert.equal(validateWindow({ scheduled_start: '2026-10-20T10:00:00Z', scheduled_end: '2026-10-20T09:00:00Z' }).ok, false);
  assert.equal(validateWindow({ ends_at: '2000-01-01T00:00:00Z' }).ok, false, 'ends_at defaults to after now');

  const client = mockClient({ isOwner: true });
  const tooLong = await handlePlatformAnnouncements(jwtEvent({ ...validCreate, title: 'x'.repeat(121) }), depsFor(client));
  assert.equal(tooLong.statusCode, 400);
  assert.equal(wrote(client, /INSERT INTO public\.platform_announcements/), false);
  assert.equal(client.queries.some((q) => q.sql === 'COMMIT'), false);

  const badWindowClient = mockClient({ isOwner: true });
  const badWindow = await handlePlatformAnnouncements(
    jwtEvent({ action: 'update', id: ROW_ID, ends_at: '2026-09-01T00:00:00Z' }),
    depsFor(badWindowClient),
  );
  assert.equal(badWindow.error, 'ends_at_before_starts_at', 'update merges the stored starts_at');
  assert.equal(wrote(badWindowClient, /UPDATE public\.platform_announcements/), false);

  const badId = await handlePlatformAnnouncements(jwtEvent({ action: 'delete', id: 'not-a-uuid' }), depsFor(mockClient({ isOwner: true })));
  assert.equal(badId.field, 'id');
  const missing = await handlePlatformAnnouncements(jwtEvent({ action: 'delete', id: ROW_ID }), depsFor(mockClient({ isOwner: true, row: null })));
  assert.equal(missing.statusCode, 404);
});
