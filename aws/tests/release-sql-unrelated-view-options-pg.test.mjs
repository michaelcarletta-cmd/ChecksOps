/**
 * The release engine's unrelated-catalog snapshot (release-sql-state.mjs) leaves a spec view's
 * reloptions to the view's own fingerprint (spec.views), so a migration may set them
 * (security_invoker); the view's owner, ACL and RLS flags, and every other relation's options,
 * stay in the `relations` category. Run on PostgreSQL 16 with SQL 90's spec, the one that
 * names a view (public.deposit_provider_config_public), and SQL 101's, which names none.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  readReleaseUnrelatedSnapshot,
  releaseChangedCategories,
} from '../../scripts/deployment-guard/lib/release-sql-state.mjs';
import { pgSkipReason, startPg } from './helpers/stakeholder-policies-pg.mjs';

const SPEC_VIEW = 'public.deposit_provider_config_public';
const OTHER_VIEW = 'public.unrelated_report_view';

const SCHEMA = `
  CREATE ROLE checksops;
  CREATE TABLE public.deposit_provider_config (id uuid PRIMARY KEY, provider text);
  CREATE VIEW ${SPEC_VIEW} WITH (security_barrier = true, security_invoker = false)
    AS SELECT id, provider FROM public.deposit_provider_config;
  CREATE VIEW ${OTHER_VIEW} AS SELECT id FROM public.deposit_provider_config;`;

const skip = pgSkipReason();

test('a spec view\'s options are not an unrelated change; its ACL and other views\' options still are', { skip: skip || false }, async () => {
  const { default: pg } = await import('pg');
  const server = startPg('pg-release-view-options-', 63300);
  const client = new pg.Client({ host: server.host, port: server.port, user: 'ubuntu', database: 'postgres' });
  await client.connect();
  try {
    await client.query(SCHEMA);
    const changed = async (key, sql) => {
      const before = await readReleaseUnrelatedSnapshot(client, key);
      await client.query(sql);
      return releaseChangedCategories(before, await readReleaseUnrelatedSnapshot(client, key));
    };

    assert.deepEqual(await changed('sql90', `ALTER VIEW ${SPEC_VIEW} SET (security_invoker = true)`), []);
    assert.deepEqual(await changed('sql90', `GRANT SELECT ON ${SPEC_VIEW} TO checksops`), ['relations']);
    assert.deepEqual(await changed('sql90', `ALTER VIEW ${OTHER_VIEW} SET (security_invoker = true)`), ['relations']);
    // A migration whose spec does not name the view still sees its options change.
    assert.deepEqual(await changed('sql101', `ALTER VIEW ${SPEC_VIEW} SET (security_invoker = false)`), ['relations']);
  } finally {
    await client.end().catch(() => {});
    server.stop();
  }
});
