import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateReadonlyCoreTables } from '../functions/api/db-readonly-validate.mjs';

test('db-readonly-validate includes legacyImagePathInventory without throwing', async () => {
  const queries = [];
  const client = {
    connect: async () => {},
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params });
      if (String(sql).startsWith('BEGIN')) return { rows: [] };
      if (String(sql).includes('current_database')) {
        return { rows: [{ current_database: 'checksops', current_user: 'checksops', transaction_read_only: 'on', default_transaction_read_only: 'on' }] };
      }
      if (String(sql).includes('to_regclass')) return { rows: [{ regclass: 'public.check_intake_items' }] };
      if (String(sql).includes('count(*)')) return { rows: [{ n: 0, row_count: 0 }] };
      if (String(sql).includes('has_table_privilege')) return { rows: [] };
      return { rows: [] };
    },
    end: async () => {},
  };

  const result = await validateReadonlyCoreTables({
    loadCredentials: async () => ({ username: 'checksops', password: 'x', host: 'db', database: 'checksops' }),
    createClient: () => client,
  });

  assert.ok('legacyImagePathInventory' in result);
});

