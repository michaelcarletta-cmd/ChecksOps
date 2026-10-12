import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SQL = fs.readFileSync(
  path.join(ROOT, 'aws/migrations/20260923_loss_draft_dashboard_view.sql'),
  'utf8',
);
const COUNT_RPC = fs.readFileSync(
  path.join(ROOT, 'supabase/migrations/20260603174139_d3b0e6eb-f9ea-4bce-8aa9-add6019fa53b.sql'),
  'utf8',
);
const ALLOWED = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'aws/functions/api/allowed-tables.json'), 'utf8'),
);

test('Loss Draft list view SQL matches count-RPC eligibility and is allowlisted', () => {
  assert.match(SQL, /CREATE OR REPLACE VIEW public\.loss_draft_dashboard/);
  assert.match(SQL, /security_invoker\s*=\s*on/);
  assert.match(SQL, /GRANT SELECT ON public\.loss_draft_dashboard TO checksops, authenticated/);
  assert.doesNotMatch(SQL, /UPDATE public\.(check_intake_items|loss_draft_tracking)/i);
  assert.doesNotMatch(SQL, /INSERT INTO public\.(check_intake_items|loss_draft_tracking)/i);
  assert.match(SQL, /escrow_status = 'endorsing'/);
  assert.match(SQL, /monitoring_type = 'not_monitored'/);
  assert.match(SQL, /endorsements_in_progress/);
  assert.match(SQL, /approved_for_deposit/);
  assert.match(COUNT_RPC, /ld\.escrow_status = 'endorsing'/);
  assert.match(COUNT_RPC, /ld\.monitoring_type = 'not_monitored'/);
  assert.ok(ALLOWED.includes('loss_draft_dashboard'));
});
