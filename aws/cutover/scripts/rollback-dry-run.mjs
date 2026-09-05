#!/usr/bin/env node
/**
 * Rollback dry-run. Prints rollback points A/B/C. Makes no changes.
 */
import { readinessSnapshot, stagingSafetyHolds } from '../../functions/api/ops-readiness.mjs';

const snap = readinessSnapshot();
const holds = stagingSafetyHolds(snap);

const report = {
  ok: holds.ok,
  wouldChangeProduction: false,
  points: {
    A: 'Before DNS/webhook switch: leave Lovable; drop failed rehearsal DBs only; keep bridges.',
    B: 'After DNS, flags still OFF: revert apex/www to recorded Lovable targets; users sign in on Supabase Auth again.',
    C: 'After provider flags ON: set AWS_PROVIDER_EXECUTION_ENABLED=false immediately, then Moov/CheckAlt/financial flags false; restore webhook URLs; do not delete provider objects.',
  },
  currentFlags: snap.flags,
  holds,
  forbidden: [
    'production DNS change',
    'production auth switch',
    'production webhook redirect',
    'Moov production execution',
    'CheckAlt production execution',
    '64_financial_activation_grants.sql',
    'bridge teardown before successful cutover',
  ],
};

console.log(JSON.stringify(report, null, 2));
process.exit(holds.ok ? 0 : 1);
