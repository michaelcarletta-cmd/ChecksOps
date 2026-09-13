import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyMigrationText,
  loadPins,
  main,
  scanMigrations,
  sha256Buffer,
} from '../../scripts/check-recipient-tax-profile-migrations.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MIGRATIONS = path.join(ROOT, 'supabase/migrations');
const PINS_PATH = path.join(ROOT, 'supabase/security/hosted-tax-profile-containment.pins.json');

function withTempMigrations(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtp-mig-guard-'));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function namesOf(result) {
  return result.violations.map((row) => row.name);
}

test('repository migrations currently pass the hash-pinned tax-profile guard', () => {
  const pins = loadPins(PINS_PATH);
  const createName = '20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql';
  const blanketName = '20260731144913_f26320f9-6473-4cc7-bda1-b4e2a0d71d97.sql';
  assert.equal(
    sha256Buffer(fs.readFileSync(path.join(MIGRATIONS, createName))),
    pins.historical_migrations.find((row) => row.basename === createName).sha256,
  );
  assert.equal(
    sha256Buffer(fs.readFileSync(path.join(MIGRATIONS, blanketName))),
    pins.historical_migrations.find((row) => row.basename === blanketName).sha256,
  );
  const { violations } = scanMigrations(MIGRATIONS, pins);
  assert.deepEqual(violations, []);
  assert.equal(main([MIGRATIONS, PINS_PATH]), 0);
});

test('CI guard catches a dangerous recipient_tax_profiles migration', () => {
  const dir = withTempMigrations({
    '20260913000000_regrant_tax_profiles.sql': `
      GRANT SELECT ON public.recipient_tax_profiles TO authenticated;
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), [
    '20260913000000_regrant_tax_profiles.sql',
  ]);
  assert.equal(main([dir, PINS_PATH]), 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('modifying the hash-pinned historical create file fails', () => {
  const name = '20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql';
  const original = fs.readFileSync(path.join(MIGRATIONS, name), 'utf8');
  const dir = withTempMigrations({
    [name]: `${original}\nGRANT SELECT ON public.recipient_tax_profiles TO anon;\n`,
  });
  const { violations } = scanMigrations(dir, loadPins(PINS_PATH));
  assert.equal(violations.length, 1);
  assert.match(violations[0].reasons.join(' '), /hash-pinned historical file was modified/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('blanket GRANT without table name fails', () => {
  const dir = withTempMigrations({
    '20260913000010_blanket.sql': `
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000010_blanket.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ALTER DEFAULT PRIVILEGES without table name fails', () => {
  const dir = withTempMigrations({
    '20260913000011_defaults.sql': `
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT ON TABLES TO authenticated;
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000011_defaults.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('multiline mixed-case blanket GRANT fails', () => {
  const dir = withTempMigrations({
    '20260913000012_mixed.sql': `
      Grant
        Select
        On All Tables
        In Schema public
        To AUTHENTICATED;
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000012_mixed.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('suspicious dynamic SQL fails', () => {
  const dir = withTempMigrations({
    '20260913000013_dyn.sql': `
      -- recipient_tax_profiles
      EXECUTE format('GRANT SELECT ON TABLE %I TO authenticated', 'recipient_tax_profiles');
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000013_dyn.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CI guard allows an unrelated migration', () => {
  const dir = withTempMigrations({
    '20260913000001_add_widget_notes.sql': `
      ALTER TABLE public.widgets ADD COLUMN notes text;
      GRANT SELECT ON public.widgets TO authenticated;
    `,
  });
  assert.deepEqual(scanMigrations(dir, loadPins(PINS_PATH)).violations, []);
  assert.equal(main([dir, PINS_PATH]), 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('CI guard allows a comment-only mention of the table', () => {
  const dir = withTempMigrations({
    '20260913000002_docs_only.sql': `
      -- recipient_tax_profiles remains contained; no privilege change.
      CREATE INDEX IF NOT EXISTS widgets_notes_idx ON public.widgets (notes);
    `,
  });
  assert.deepEqual(scanMigrations(dir, loadPins(PINS_PATH)).violations, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('allowlisted historical create migration is not a violation when unchanged', () => {
  const name = '20260709195755_af0fb428-7cf4-4ac3-9fc6-d04ed189b490.sql';
  const dir = withTempMigrations({
    [name]: fs.readFileSync(path.join(MIGRATIONS, name), 'utf8'),
  });
  assert.deepEqual(scanMigrations(dir, loadPins(PINS_PATH)).violations, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('quoted, schema-qualified, and mixed-role blanket GRANT fails', () => {
  const dir = withTempMigrations({
    '20260913000014_quoted.sql': `
      GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "authenticated";
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000014_quoted.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GRANT ON ALL TABLES to PUBLIC fails', () => {
  const dir = withTempMigrations({
    '20260913000015_public.sql': `
      grant select on all tables in schema public to PUBLIC;
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000015_public.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('psql include concealment fails', () => {
  const dir = withTempMigrations({
    '20260913000016_include.sql': `
      \\i /tmp/hidden_grants.sql
    `,
  });
  assert.deepEqual(namesOf(scanMigrations(dir, loadPins(PINS_PATH))), ['20260913000016_include.sql']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('GRANT ON ALL TABLES to postgres is not a Data API blanket grant', () => {
  const dir = withTempMigrations({
    '20260913000017_cron.sql': `
      GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA cron TO postgres;
    `,
  });
  assert.deepEqual(scanMigrations(dir, loadPins(PINS_PATH)).violations, []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('hash-pinned exception without review metadata fails', () => {
  const name = '20260913000018_reviewed.sql';
  const body = 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;\n';
  const dir = withTempMigrations({ [name]: body });
  const pins = {
    historical_migrations: [
      { basename: name, sha256: sha256Buffer(Buffer.from(body)), review: '' },
    ],
  };
  const { violations } = scanMigrations(dir, pins);
  assert.equal(violations.length, 1);
  assert.match(violations[0].reasons.join(' '), /review metadata/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('classifyMigrationText documents static-scan limits without hiding blanket grants', () => {
  assert.ok(classifyMigrationText('GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon;').length > 0);
  assert.deepEqual(classifyMigrationText('ALTER TABLE public.widgets ADD COLUMN n int;'), []);
});
