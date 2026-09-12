import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadAllowlist, main, scanMigrations } from '../../scripts/check-recipient-tax-profile-migrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const ALLOWLIST_PATH = path.join(ROOT, 'scripts/recipient-tax-profile-migration-allowlist.txt');

function withTempMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-mig-guard-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

test('repository migrations currently pass the tax-profile privilege guard', () => {
  const allowlist = loadAllowlist(ALLOWLIST_PATH);
  assert.equal(allowlist.has('20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql'), true);
  const { violations } = scanMigrations(MIGRATIONS, allowlist);
  assert.deepEqual(violations, []);
  assert.equal(main([MIGRATIONS, ALLOWLIST_PATH]), 0);
});

test('CI guard catches a dangerous recipient_tax_profiles migration', () => {
  const dir = withTempMigrations({
    '20260913000000_regrant_tax_profiles.sql': `
      GRANT SELECT ON public.recipient_tax_profiles TO authenticated;
    `,
  });
  const allowlist = new Set();
  const { violations } = scanMigrations(dir, allowlist);
  assert.deepEqual(violations, ['20260913000000_regrant_tax_profiles.sql']);
  assert.equal(main([dir, ALLOWLIST_PATH]), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CI guard allows an unrelated migration', () => {
  const dir = withTempMigrations({
    '20260913000001_add_widget_notes.sql': `
      ALTER TABLE public.widgets ADD COLUMN notes text;
      GRANT SELECT ON public.widgets TO authenticated;
    `,
  });
  const { violations } = scanMigrations(dir, new Set());
  assert.deepEqual(violations, []);
  assert.equal(main([dir, ALLOWLIST_PATH]), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CI guard allows a comment-only mention of the table', () => {
  const dir = withTempMigrations({
    '20260913000002_docs_only.sql': `
      -- recipient_tax_profiles remains contained; no privilege change.
      CREATE INDEX IF NOT EXISTS widgets_notes_idx ON public.widgets (notes);
    `,
  });
  const { violations } = scanMigrations(dir, new Set());
  assert.deepEqual(violations, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allowlisted historical create migration is not a violation', () => {
  const name = '20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql';
  const dir = withTempMigrations({
    [name]: fs.readFileSync(path.join(MIGRATIONS, name), 'utf8'),
  });
  const allowlist = loadAllowlist(ALLOWLIST_PATH);
  const { violations } = scanMigrations(dir, allowlist);
  assert.deepEqual(violations, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
